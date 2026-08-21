# Plan: Perbaikan grid bot — jebakan level teratas, re-range, dan loop refleksi yang bisa belajar

| | |
|---|---|
| **Tanggal** | 2026-08-21 |
| **Status** | Draft — menunggu persetujuan |
| **Dasar analisis** | `data/decision-log.json` periode 2026-07-24 → 2026-08-21 (2 trade closed) |
| **Keputusan operator** | Grid 1900–2500 step 100 · Scope P0 + P1 evaluator · `seed-atr-guard` diturunkan ke 4% |

> Konvensi nama berkas untuk plan berikutnya: `docs/plan-YYYY-MM-DD-<topik>.md`

---

## Context

Analisis 28 hari log trading (2 trade closed, +10.81 USDT gross) memunculkan tiga masalah yang saling berkaitan:

1. **Defect aktif — lot tanpa exit.** Grid `1500..2200 step 100` membuat 2200 jadi level teratas. `sellTargetFor` (`src/strategies/grid.ts:88`) mencari level *di atas* harga masuk, jadi untuk lot di 2200 ia return `undefined`, lalu `decideTick:181` melakukan `continue` — lot itu tidak pernah dapat sell order, tidak pernah masuk `holdState`, diam selamanya. Sementara `targetBidLevels` dengan senang hati memasang bid di sana. Bid `dry-buy-14` di level 2200 **sedang menggantung sekarang** di `data/positions.json:5`. Akar masalahnya konseptual: grid dengan N level hanya punya **N−1 slot yang bisa ditradingkan** — level teratas adalah target jual, bukan level beli. Kode belum tahu itu.

2. **Grid ditinggal pasar.** Harga terakhir 2349.30, `GRID_UPPER=2200`. Seluruh grid ada di bawah pasar, bot efektif idle sambil tetap mengunci 800 USDT. Level 1500/1600/1700 (300 USDT, 37.5% modal) tidak pernah tersentuh sebulan ini. README:311 menyatakan re-range adalah keputusan operator — dan momennya pas karena **lot terbuka = 0**, jadi tidak ada target jual yang teroprhan.

3. **Sinyal feedback evaluator degenerate.** Karena no-cutloss dan jual tepat satu level di atas: `exitPrice >= target > entryPrice` selalu, jadi **win rate 100% secara matematis, selamanya** — lot yang "rugi" tidak pernah ditutup, cuma tidak pernah selesai. Dan `pnlPct` adalah fungsi deterministik dari `gridLevel` (beli 1800 → selalu +5.56%; beli 1900 → selalu +5.26%), bukan fungsi kondisi pasar. Tapi `buildReport` mem-bucket trade per indikator lalu melaporkan **win% dan avg pnl%** — dua metrik konstan. Semua bucket akan melaporkan angka identik; LLM diminta mencari korelasi yang secara matematis mustahil ada.

   Satu-satunya variabel yang membawa informasi adalah **holding time**: 631.7h vs 41.1h untuk PnL% yang praktis sama. Diterjemahkan ke uang: 0.20 %/hari-modal vs 3.25 %/hari-modal — **16× lebih efisien**. Di strategi tanpa cutloss, *opportunity cost*-lah risiko sesungguhnya, dan itu belum diukur di mana pun.

   Bonus: `seed-atr-guard` (`atrPct > 12`) belum pernah menyala — ATR tertinggi yang pernah tercatat 2.50%. Bucket ATR di evaluator pakai edges `[4, 8, 12]` sehingga **semua trade jatuh di satu bucket `<4`**, tabelnya nol daya pembeda.

**Hasil yang dituju:** bot tidak bisa lagi masuk posisi yang tak punya jalan keluar; grid kembali mengelilingi harga dengan ladder mengarah ke bawah; dan saat trade ke-5 tiba nanti, loop refleksi punya sinyal yang benar-benar bervariasi untuk dipelajari.

> Pre-step: ada kerja belum di-commit di `src/report.ts` + `test/report.test.ts` (fitur `adviseGridStep`). Plan ini menumpuk di atasnya. Sebaiknya di-commit dulu agar diff batch ini bersih.

---

## Bagian 1 — P0: Defect level teratas

### `src/strategies/grid.ts` — `targetBidLevels` (baris 70–81)

Batasi kandidat beli ke level yang punya target jual di atasnya. Karena `levels` sudah ascending, itu berarti semua level kecuali yang terakhir:

```ts
const biddable = levels.slice(0, -1);  // level teratas hanya target jual
```
lalu filter `l <= price && !taken.has(l)` berjalan di atas `biddable`, bukan `levels`.

Perbarui docstring: jelaskan grid N level = N−1 slot tradeable, dan bahwa ini yang menjaga invarian "setiap lot yang dibuka punya target jual".

Tidak perlu menyentuh `sellTargetFor` — perilakunya sudah benar dan sudah dites (`test/agent.test.ts:89`). Yang salah adalah sisi entry yang membuat kondisi itu bisa tercapai.

Edge case yang tetap aman: `sellTargetFor` pakai `max(gridLevel, entryPrice)`, tapi limit buy tidak bisa fill di atas harga limitnya, jadi `entryPrice <= gridLevel` selalu — `slice(0, -1)` menutup kasusnya dengan tuntas.

### `test/agent.test.ts` — regression test

Saat ini **tidak ada satu pun test dengan harga di atas `config.upper`**, itu sebabnya jebakan ini lolos. Tambahkan di `describe('grid maths')` dan blok `decideTick`:

- `targetBidLevels(3250, gridLevels(config), [], 3)` → `[3100, 3000, 2900]`, bukan `[3200, 3100, 3000]` (config `upper: 3200`).
- Test level `decideTick`: harga di atas `upper`, positions kosong → tidak ada entri di `plan.placeBids` yang `gridLevel === config.upper`.

Test yang sudah ada di baris 71 dan 77 pakai harga 3050 (< upper 3200) sehingga tidak terpengaruh.

---

## Bagian 2 — P0: Re-range grid ke 1900–2500

Murni konfigurasi, tanpa perubahan kode.

### `.env`
| | Lama | Baru |
|---|---|---|
| `GRID_LOWER` | 1500 | **1900** |
| `GRID_UPPER` | 2200 | **2500** |
| `GRID_STEP` | 100 | 100 (tetap) |
| Level | 8 | **7** |
| Modal terikat | 800 USDT | **700 USDT** |
| `MAX_DRAWDOWN_USDT` | 400 | **350** |

Drawdown ikut turun agar komentarnya tetap jujur — komentar di `.env` mengklaim "trip di ~50% kerugian unrealized", dan 400/800 = 50% sekarang jadi 350/700. Perbarui juga teks komentarnya (`8 level x 100` → `7 level x 100`).

Hasilnya: harga 2349 duduk dekat atap kotak, bid aktif di 2300/2200/2100, dan 2500 hanya jadi target jual.

```
  2500 ┤ jual saja (tidak dibeli)
  2400 ┤
▶ 2349 ←── harga sekarang
  2300 ┤ ● bid
  2200 ┤ ● bid
  2100 ┤ ● bid
  2000 ┤
  1900 ┤
```

### Tidak perlu intervensi manual pada `data/positions.json`

Bot merapikan sendiri di tick berikutnya lewat `cancelBids = positions.bids.filter(b => !wantedSet.has(b.gridLevel))` (`grid.ts:159`):
- bid 2000 → dibatalkan (bukan lagi salah satu dari 3 level teratas di bawah harga)
- bid 2200 & 2100 → dipertahankan apa adanya, masih level valid di grid baru
- bid 2300 → dipasang baru

Dan 2200 kini bukan level teratas lagi, jadi jebakannya hilang. `data/decision-log.json` **dipertahankan** — itu sumber win rate yang durabel sekaligus data latih evaluator.

### `.env.example`
Biarkan (template generik 2800–4200, bukan config live).

---

## Bagian 3 — P1: Retune `seed-atr-guard`

### `data/lessons.json`
- `seed-atr-guard.when[0].value`: `12` → **`4`**
- Tulis ulang `rationale`: sebutkan ATR maksimum teramati 2.50% pada periode 2026-07-24…2026-08-21, sehingga ambang 12 mustahil menyala; 4 duduk di atas semua yang pernah terjadi tapi masih dalam orde yang realistis. Ini sekaligus menaati aturan evaluator sendiri di `SYSTEM_PROMPT`: *"Thresholds must sit inside the range actually observed in the data."*
- `version`: `1` → `2`, `updatedAt` → waktu edit.

**Konsekuensi yang disengaja:** `shouldRun` membandingkan `updatedAt` dengan timestamp trade, jadi menyetel `updatedAt` ke sekarang berarti evaluator butuh trade yang closed *setelah* momen ini. Gate-nya tetap 5 trade closed dan kita baru punya 2, jadi tidak ada yang hilang secara praktis — dan memang benar bahwa rule yang baru diubah harus menunggu bukti baru.

`seed-rsi-guard` **tidak disentuh**: 6 blokir, nol kerugian dicegah, nol fill hilang — belum teruji, bukan terbukti jelek. Biarkan evaluator yang memutuskan saat datanya cukup.

---

## Bagian 4 — P1: Bikin loop refleksi bisa belajar

### `src/report.ts` — metrik efisiensi modal (definisi tunggal)

Tambahkan dan ekspor satu helper murni, dipakai bersama oleh report CLI dan evaluator supaya metriknya cuma punya satu definisi:

```ts
/** Return % per hari modal terkunci. Satu-satunya metrik outcome yang bervariasi:
 *  win rate 100% by construction, dan pnlPct ditentukan oleh level mana yang fill. */
export function pctPerDay(d: Decision): number
```
= `pnlPct / (holdingHours / 24)`, dengan guard `holdingHours <= 0`.

Perluas `DailyStats` + `groupByDay` + `overallStats` + `printTable` dengan kolom `avgHoldingHours` dan `avgPctPerDay`. Ini yang bikin selisih 631h vs 41h terbaca sebagai uang di `bun run report`.

### `src/strategies/evaluator.ts` — ganti sumbu outcome

1. **`bucketise` (baris ~112–140)** — ganti baris per bucket dari
   `${n} trades, ${win}% win, avg ${pnl}%`
   menjadi
   `${n} trades, avg ${pnl}%, median hold ${h}h, ${eff}%/hari`.
   Import `pctPerDay` dari `../report.ts`. Tetap bucket **berdasarkan indikator entry**, tapi laporkan **holding time + %/hari** sebagai outcome — itu langsung menjawab "kondisi entry mana yang bikin modal cepat berputar vs terkunci lama".

2. **Kalibrasi ulang edges ATR (baris ~177)**: `[4, 8, 12]` → **`[0.5, 1.0, 2.0]`**, sesuai rentang teramati 0.40–2.50%. Edges RSI `[35, 50, 65]` dan EMA-spread `[-2, 0, 2]` sudah membelah data dengan benar — biarkan.

3. **`SUMMARY` (baris ~172–176)**: tambahkan median hold dan avg %/hari di samping angka yang sudah ada.

4. **`SYSTEM_PROMPT` (baris ~28–56)** — ini yang paling menentukan. Tambahkan secara eksplisit:
   - Win rate **100% by construction** (no-cutloss: lot yang rugi tidak pernah ditutup, hanya ditahan) sehingga tidak membawa informasi apa pun — jangan pakai sebagai bukti.
   - `pnlPct` ditentukan oleh level grid mana yang fill, **bukan** oleh kondisi pasar.
   - Metrik outcome yang sesungguhnya adalah **holding time dan %/hari**: biaya nyata strategi ini adalah modal terkunci, bukan loss.
   - Rangka berpikir untuk rule entry: `block_entry` **hanya bisa menolong saat downtrend dan hanya bisa merugikan saat uptrend**, karena setiap lot toh akhirnya dijual profit.

5. **`LessonEvidence`** (`src/types.ts:36-40`) dan `LESSONS_SCHEMA.evidence` (baris ~85–94): tambahkan `avgPctPerDay: number` ke properties dan ke `required`. Aman tanpa migrasi — `evidence` bersifat opsional (`evidence?`) dan kedua seed rule belum punya field itu.

### `test/evaluator.test.ts` — fixture harus mencerminkan rezim nyata

Fixture `syntheticTrades()` (baris 25–44) sekarang pakai atrPct 3 dan 14, yang tidak pernah terjadi di ETH 1h. Perbarui:
- ATR: calm `0.6`, volatil `2.2` (masuk ke edges baru `[0.5, 1.0, 2.0]`).
- Variasikan `holdingHours` — saat ini konstan 20 untuk semua, sehingga metrik baru tidak teruji. Buat calm cepat berputar (mis. 20h) dan volatil terkunci lama (mis. 400h), meniru pola nyata yang teramati.
- Perbarui assertion baris 104–105 ke edges dan format keluaran yang baru.
- Tambah test bahwa angka `%/hari` muncul dan benar-benar membedakan antar bucket.

`test/agent.test.ts` tidak terpengaruh perubahan ATR ini — fixture ATR di sana membangun rule-nya sendiri untuk menguji rule engine secara generik, bukan kalibrasi.

---

## Berkas yang disentuh

| Berkas | Perubahan |
|---|---|
| `src/strategies/grid.ts` | `targetBidLevels` kecualikan level teratas |
| `test/agent.test.ts` | regression test jebakan level teratas (2 test baru) |
| `.env` | `GRID_LOWER`/`GRID_UPPER`/`MAX_DRAWDOWN_USDT` + komentar modal |
| `data/lessons.json` | `seed-atr-guard` 12 → 4, rationale, version 2 |
| `src/report.ts` | ekspor `pctPerDay`, kolom hold + %/hari |
| `test/report.test.ts` | cakup kolom baru |
| `src/strategies/evaluator.ts` | `bucketise` outcome, edges ATR, SUMMARY, `SYSTEM_PROMPT`, schema evidence |
| `src/types.ts` | `LessonEvidence.avgPctPerDay` |
| `test/evaluator.test.ts` | fixture realistis + assertion baru |

Tidak ada I/O baru yang masuk ke `decideTick` — semua perubahan sisi strategi tetap fungsi murni, sesuai konvensi CLAUDE.md.

---

## Verifikasi

1. **Suite penuh**: `bun test` — semua hijau, tanpa network/API key.
2. **Regression jebakan**: `bun test test/agent.test.ts` — konfirmasi test baru gagal kalau `slice(0, -1)` dihapus (uji test-nya sendiri sebelum dianggap selesai).
3. **Report**: `bun run report` — kolom hold dan %/hari muncul; lot 1900 harus terbaca ~0.20 %/hari dan lot 1800 ~3.25 %/hari, membuktikan metriknya benar-benar membelah data nyata.
4. **Smoke dry-run**: `bun run start` beberapa tick, verifikasi di log:
   - header grid menunjukkan `7 levels 1900..2500`
   - `capital: 700 USDT fully at risk`
   - bid 2000 dibatalkan, 2200 & 2100 bertahan, 2300 dipasang
   - **tidak pernah** ada bid di 2500
5. **Uji manual jebakan**: setel sementara `GRID_UPPER` di bawah harga pasar, jalankan satu tick, pastikan bot memasang bid di level tertinggi *kedua* dan bukan di `upper`.
6. **Evaluator masih tergating**: `bun run evaluate` harus keluar dengan `not-enough-trades` (2 < 5) — tidak menghabiskan token dan tidak menulis `lessons.json`.

---

## Yang sengaja TIDAK dikerjakan di batch ini

Ditunda ke plan berikutnya (P2 dari analisis):

- **Instrumentasi durasi blokir.** `entry_blocked` hanya dicatat saat transisi (`grid.ts:152`), jadi kita cuma punya titik transisi, bukan berapa lama entry diblokir — padahal `SYSTEM_PROMPT` sendiri menyuruh LLM mendeteksi rule yang terlalu ketat. Butuh state snapshot berkala.
- **Estimasi fee di samping PnL gross.** Sekarang 0.4 dari 10.81 USDT (~3.7%), kecil. Tapi kalau `GRID_STEP` dipersempit ke ~1%, fee memakan ~20% profit — ini yang harus jadi pertimbangan utama sebelum memperkecil step.
- **Step geometris.** Step $100 fixed berarti lebar step dalam persen menyusut saat harga naik (5.26% di 1900, 4.26% di 2349). Grid tidak rata secara geometris. Perubahan desain tersendiri.
- **`seed-rsi-guard`.** Dibiarkan sampai ada bukti.
