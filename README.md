# Autonomous ETH Grid Trading Agent

Bot grid trading spot ETH/USDT (Bun + TypeScript) dengan memori: setiap keputusan
dicatat beserta snapshot indikator, dan sebuah reflection loop harian memakai LLM
untuk merevisi aturan yang dibaca bot sebelum tiap entry dan exit.

Strateginya mengikuti `docs/ethereum.pdf` ("Trading Cicilan Ethereum"): spot only,
cicil turun, tanpa cutloss, tiap lot dicatat dan dijual terpisah di level grid
berikutnya.

## Quick start

```bash
bun install
cp .env.example .env        # isi ANTHROPIC_API_KEY untuk evaluator

bun test                    # test suite, tanpa jaringan
bun run start               # bot loop (default: dry-run)
bun run evaluate            # reflection loop (butuh trade tertutup + API key)
bun run report              # win rate & PnL per hari (--json untuk mesin)
bun run reset-breaker       # clear circuit breaker yang ke-trip
```

Default `.env` adalah `DRY_RUN=true` — tidak ada order yang dikirim. Untuk
mengubah itu, baca **Safety** di bawah.

## Cara kerjanya

```
   data/lessons.json ─────────────┐
                                  ▼
harga + OHLCV ──► indikator ──► rule engine ──► order ──► data/positions.json
                                  │                            │
                                  └──► data/decision-log.json ◄─┘
                                                │
                              (harian)          ▼
                          evaluator ──► LLM ──► lessons.json  (revisi)
```

Tiap tick (default 60 detik):

1. Ambil harga live + OHLCV. **Candle terakhir dibuang** — itu candle yang sedang
   terbentuk, close dan volume-nya berubah tiap poll, dan akan membuat rule
   menyala-padam dalam jam yang sama.
2. Hitung `rsi14`, `atrPct`, `ema20`, `ema50`, `emaSpreadPct`, `volumeRatio`.
3. Rekonsiliasi: order yang terisi jadi lot / menutup lot, PnL dicatat.
4. Muat ulang `lessons.json` (evaluator bisa menulisnya kapan saja — tanpa restart).
5. Putuskan, lalu eksekusi.

### Sisi entry — bid nongkrong

Bot memasang limit buy di `MAX_OPEN_BIDS` level kosong terdekat di bawah harga.
Bid memang harus nongkrong: kalau hanya satu bid dipasang dan harga gap turun
menembus beberapa level sekaligus, level-level itu terlewat tanpa terisi.

Satu level = maksimum satu lot. Setelah lot terjual, level itu di-bid lagi —
inilah pola *bid → beli → jual → bid lagi* dari PDF.

Kalau sebuah rule `block_entry` menyala, **semua bid yang sedang nongkrong
di-cancel**. Rule yang bilang "jangan masuk sekarang" tidak ada artinya kalau
order yang dipasang di bawah rule lama masih duduk di order book.

### Sisi exit — dieksekusi saat poll, bukan nongkrong

Sell **tidak** dipasang nongkrong di target. Sell yang nongkrong akan dieksekusi
exchange begitu harga menyentuhnya — yaitu sebelum bot sempat poll lagi — sehingga
rule `hold_sell` tidak akan pernah bisa mencegahnya. Jadi sell baru dikirim setelah
harga mencapai target **dan** rule sudah dievaluasi.

Ini persis alasan penulis PDF trading manual: menahan keputusan exit di tangan
sendiri, bukan memarkirnya di order book, adalah satu-satunya cara hold untuk
gerakan yang lebih besar bisa terjadi.

Order sell dikirim sebagai limit di harga target (bukan market), jadi harga eksekusi
tidak pernah di bawah target.

Konsekuensinya: dengan poll 60 detik, spike yang naik melewati target lalu balik
turun dalam satu interval bisa terlewat. Itu harga yang dibayar agar `hold_sell`
benar-benar berkuasa.

## lessons.json — rule, bukan prose

Kalau lesson berupa kalimat bebas ("hindari entry saat volatil"), bot tidak bisa
mengevaluasinya — hanya bisa menyuapkannya balik ke LLM tiap tick. Jadi lesson
adalah predikat yang bisa dieksekusi mesin:

```json
{
  "id": "atr-spike-block",
  "action": "block_entry",
  "when": [{ "indicator": "atrPct", "op": ">", "value": 12 }],
  "rationale": "6 dari 7 entry saat ATR>12% ditutup rugi.",
  "evidence": { "trades": 7, "winRate": 0.14, "avgPnlPct": -3.2 }
}
```

- `when` di-AND. Rule tanpa kondisi tidak pernah menyala (kalau tidak, rule cacat
  akan menghentikan semua trading).
- `action`: `block_entry` menolak buy baru; `hold_sell` menahan lot melewati
  target +1 grid.
- `indicator` harus salah satu field numerik di `IndicatorSnapshot`.
- `rationale` untuk dibaca manusia. Yang dieksekusi mesin adalah `when`.

`data/lessons.json` diseed dengan dua rule konservatif dari doktrin PDF, ditandai
jelas sebagai belum berbasis bukti. Evaluator akan mengonfirmasi, menyetel, atau
membuangnya begitu ada trade nyata.

## Reflection loop

`bun run evaluate` — dirancang untuk cron harian.

Gate sebelum memanggil API (menghindari bakar token dan churn rule tanpa bukti baru):

- < 5 trade tertutup → berhenti.
- tidak ada trade tertutup sejak revisi terakhir → berhenti.

Kalau lolos, ia menyusun laporan: tiap trade tertutup satu baris (indikator saat
entry, PnL%, jam holding), plus agregat dan bucket by ATR / RSI / EMA-spread supaya
LLM melihat sinyal, bukan cuma baris. Entry yang diblokir juga disertakan — tanpa
itu evaluator hanya melihat trade yang jalan dan tidak pernah tahu rule-nya
kelewat ketat.

LLM (`claude-opus-4-8`, structured outputs) mengembalikan **set rule pengganti yang
lengkap**. Constraint semantik yang tidak bisa diekspresikan schema divalidasi di
sisi klien — maksimum 8 rule, id unik, tidak ada rule tanpa kondisi, threshold
harus berhingga. Pelanggaran = abort, bukan diperbaiki diam-diam: rule set yang
salah akan mengarahkan setiap trade berikutnya.

Versi lama di-backup ke `data/lessons.bak.json`; `version` bertambah.

### Backend LLM — API key atau Claude Code

`LLM_PROVIDER` memilih cara evaluator menghubungi model:

| `LLM_PROVIDER` | Auth | Schema | Cron |
|---|---|---|---|
| `api` | `ANTHROPIC_API_KEY` | dijamin server-side (`output_config.format`) | jalan di mana saja |
| `claude-code` | login subscription Claude Code | tidak dijamin — schema di prompt, output divalidasi klien | butuh `claude` di PATH + login valid di user itu |
| kosong (auto) | — | — | api kalau `ANTHROPIC_API_KEY` diisi, selain itu claude-code |

Rute `claude-code` shell out ke `claude -p --output-format json --model opus`, jadi
tanpa API key sama sekali — pakai kuota subscription. Karena tidak ada schema
enforcement, output di-strip fence markdown lalu di-`JSON.parse`; `validate()` yang
sama tetap menjaga constraint semantik (max 8 rule, id unik, dst). Kalau CLI tidak
ada di PATH atau belum login, evaluator gagal dengan pesan jelas — set
`LLM_PROVIDER=api` sebagai gantinya.

Catatan: cron yang jalan sebagai user berbeda tidak melihat login Claude Code kamu;
pastikan `claude` dan sesi login-nya ada di lingkungan cron itu.

`ANTHROPIC_BASE_URL` bisa diarahkan ke endpoint Anthropic-compatible lain (proxy/
gateway lokal, dst) — dibaca otomatis oleh `@anthropic-ai/sdk`, tidak perlu kode
tambahan. `LLM_MODEL` menimpa model default (`claude-opus-4-8`) — pakai ini kalau
gateway-nya cuma punya credential untuk model/alias tertentu, misalnya
`LLM_MODEL=daily-code`.

Cron:

```
0 2 * * * cd ~/Herd/ethereum-bot-trading && /path/to/bun run src/strategies/evaluator.ts >> data/evaluator.log 2>&1
```

## Safety

| `DRY_RUN` | `TESTNET` | Efek |
|---|---|---|
| `true` | `false` | **Default yang disarankan.** Data pasar nyata, tidak ada order dikirim, fill disimulasikan jujur (buy terisi hanya kalau harga benar-benar menyentuhnya). |
| `true` | `true` | Sama, tapi data dibaca dari sandbox Binance. |
| `false` | `true` | Order sungguhan di testnet Binance. |
| `false` | `false` | **Uang nyata.** Butuh `LIVE_CONFIRM=i-understand-the-risk`, kalau tidak proses menolak start. |

Dry-run tidak instant-fill order di harga limit — itu akan membuat grid terlihat
jauh lebih menguntungkan daripada kenyataannya.

## Circuit breaker

Safety cutout, **bukan stop loss**. Strategi ini no-cutloss, jadi breaker tidak
pernah jual rugi. Yang dilakukannya: berhenti menaruh modal baru saat ada yang
salah — halt entry baru + cancel semua bid nongkrong — sambil **lot existing
tetap dipegang dan sell tetap jalan** (nutup lot di target justru mengurangi
eksposur).

Tiga kondisi independen, semua nol = mati:

| Env | Trip saat | Perilaku |
|---|---|---|
| `MAX_DRAWDOWN_USDT` | kerugian unrealized (mark-to-market) semua lot terbuka lewat batas | **latch** — risiko utama grid no-cutloss: harga tembus seluruh ladder, semua lot underwater |
| `MAX_CONSECUTIVE_ERRORS` | N tick gagal beruntun (exchange mati/auth rusak) | **latch** — loop biasanya cuma log lalu lanjut; bertindak di atas exchange rusak lebih buruk dari berhenti |
| `MAX_PRICE_JUMP_PCT` | harga lompat > X% vs tick sebelumnya | **skip tick** (bukan latch) — glitch feed sesaat di-skip lalu pulih sendiri; crash beneran bergerak bertahap jadi tidak ke-skip |

**Latch = sekali trip tidak auto-clear** (kalau tidak, bisa trip-reset-trip berulang
sambil bakar fee). State disimpan ke `data/breaker.json` — restart pun tetap halted.
Reset manual setelah paham kenapa trip:

```bash
bun run reset-breaker    # print alasan trip lalu clear
```

**Jujur soal batasnya:** breaker membatasi *penambahan* modal, bukan drawdown itu
sendiri. Lot yang sudah underwater tetap dipegang (itu strateginya). Satu-satunya
alat sungguhan untuk memotong drawdown — cutloss — memang sengaja tidak ada.

## Data files

| File | Isi |
|---|---|
| `data/lessons.json` | Rule aktif. Dibaca bot tiap tick, ditulis evaluator. |
| `data/positions.json` | Lot terbuka + bid yang nongkrong. |
| `data/decision-log.json` | Setiap entry, exit, block, dan hold. Input evaluator. |
| `data/breaker.json` | State circuit breaker (tripped/reason/error streak). Reset via `bun run reset-breaker`. |
| `data/bot.lock` | Single-instance lock (pid/host). Ada selama bot jalan; hilang saat exit bersih. |

Semua tulis bersifat atomik (temp file + rename), jadi crash di tengah tulis tidak
pernah meninggalkan JSON separuh. File yang korup dipindahkan ke samping, bukan
ditimpa.

Arahkan `DATA_DIR` ke direktori lain untuk eksperimen tanpa menyentuh state nyata.

### Single-instance lock

Bot mengunci `data/bot.lock` saat start (atomic exclusive-create). Instance kedua
ke `DATA_DIR` yang sama **menolak start** — dua instance akan menaruh order dobel.
Lock dilepas otomatis saat exit bersih (SIGINT/SIGTERM). Kalau bot crash tanpa
sempat melepas, lock jadi *stale*: start berikutnya cek apakah pid pemegang masih
hidup di host ini — kalau mati, lock diambil alih otomatis.

Batasnya (single-host): pid cuma bermakna di host yang sama. Kalau `DATA_DIR` di
NFS lintas host, pid pemegang dari host lain tidak bisa diverifikasi → dianggap
hidup, start ditolak (arah aman). Untuk multi-host butuh lock terdistribusi
sungguhan (baris DB / redis). Kalau yakin pemegang sudah mati, hapus manual
`data/bot.lock`.

## Deploy: dry-run soak di server

Menjalankan bot berhari-hari dalam mode simulasi (tanpa order asli) lalu me-review
win rate. Yang dikumpulkan cukup dari bot loop + `bun run report` — evaluator/LLM
**tidak** diperlukan untuk ini.

1. Di server: install Bun, clone repo, `bun install`.
2. `cp .env.example .env`, isi grid + `DRY_RUN=true` `TESTNET=true`. Exchange key
   boleh kosong (read-path tanpa auth). Set `GRID_UPPER/LOWER` mengelilingi harga
   ETH saat ini, kalau tidak nol bid akan terpasang.
3. Jalankan sebagai service (auto-restart, survive reboot) — template ada di
   `deploy/grid-bot.service`. Edit placeholder (`User`, path, path `bun`), lalu:

   ```bash
   sudo cp deploy/grid-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now grid-bot
   journalctl -u grid-bot -f          # ikuti log
   ```

   Bukan systemd? `pm2 start "bun run src/index.ts" --name grid-bot`, atau
   `nohup bun run src/index.ts &` (nohup tidak auto-restart).

4. Review win rate kapan saja, dari dir repo:

   ```bash
   bun run report                     # tabel per hari + total
   bun run report --json              # untuk mesin
   ```

**Integritas data lintas restart:** `decision-log.json` (sumber win rate) durable di
disk, jadi restart/crash tidak menghapus riwayat trade tertutup — win rate berhari-hari
tetap akurat. Yang hilang saat restart cuma bid nongkrong (langsung di-replace tick
berikutnya) dan fill yang kebetulan jatuh di jendela restart (hitungan detik).

**Catatan simulasi:** fill dry-run disimulasikan dari harga pasar nyata — buy terisi
hanya saat harga benar-benar menyentuhnya, bukan instant-fill. Ini jujur, tapi tetap
simulasi: tidak ada order book effect, tidak ada partial fill, fee belum dihitung
(win rate PnL adalah gross). Angkanya indikatif, bukan janji hasil live.

## Layout

```
src/
  types.ts              tipe bersama
  config.ts             env + validasi, guard live-trading
  core/
    exchange.ts         ccxt + exchange dry-run
    indicators.ts       RSI / ATR / EMA / volume ratio (tanpa dependency)
    memory.ts           JSON atomik + write queue
  strategies/
    grid.ts             level, rule engine, decideTick (murni, tanpa I/O)
    evaluator.ts        reflection loop (juga entrypoint CLI)
  index.ts              main loop + rekonsiliasi
test/
  agent.test.ts         matematika grid, rule engine, indikator
  evaluator.test.ts     gate, laporan, validasi, merge rule
  loop.test.ts          round-trip end-to-end lewat fake exchange
```

`decideTick` adalah fungsi murni — semua logika trading ada di situ, dan itulah
sebabnya test bisa jalan tanpa exchange maupun jaringan. `index.ts` yang melakukan
efek samping.

## Batasan yang perlu diketahui

**Grid tanpa cutloss punya profil khas**: sering menang kecil, sesekali rugi besar
kalau harga menembus jauh di bawah `GRID_LOWER` dan modal habis. PDF sendiri
mengakuinya. Reflection loop mengetatkan *entry timing*; ia **tidak** bisa membatasi
drawdown, karena satu-satunya alat sungguhan untuk itu — cutloss — sengaja
ditiadakan strategi. `USDT_PER_LEVEL` × jumlah level = uang yang sepenuhnya berisiko.

**Sinyalnya lambat.** Pada ~3 trade/bulan seperti angka PDF, butuh berbulan-bulan
sebelum ambang "minimal 5 trade per rule" menghasilkan sesuatu yang bermakna.

**PnL yang dicatat adalah gross.** Fee exchange (~0.1% per sisi di Binance spot,
jadi ~0.2% pulang-pergi) tidak dikurangkan. Pada grid $100 di ETH $3000 itu sekitar
0.2% dari 3.3% gross.

**Range grid statis.** `GRID_UPPER`/`GRID_LOWER` dari env. Ide "padatkan cicilan di
sekitar harga sekarang" dari PDF adalah keputusan operator, bukan otomatis.

## Sengaja tidak ada

Database (file JSON cukup sampai puluhan ribu decision), backtester, dashboard web,
notifikasi, dan auto-rebalance range grid.
