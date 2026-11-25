# FLOP Testnet Agent Faucet Claim

Script Node.js lokal untuk klaim **10 FLOP Testnet** ke address `5xxx` via `POST https://faucet.flop.network/v1/testnet/agent-claims`, lalu cek saldo langsung ke `wss://testnet.flop.network/`.

Keamanan:
- Mnemonic Talisman hanya dibaca lewat prompt tersembunyi (tidak disimpan ke file, tidak di-log, dan tidak dikirim ke server mana pun).
- Script memverifikasi address hasil derivasi (`sr25519`, SS58 `42`) harus persis `5xxx`. Jika beda, script langsung berhenti.
- Script hanya menghubungi `https://faucet.flop.network` dan `wss://testnet.flop.network/`.

## Cara Pakai di Windows 10 PowerShell

### 1. Install Node.js (jika belum ada)
Install Node.js LTS (versi 20+ atau 22+):
```powershell
winget install OpenJS.NodeJS.LTS
```
Atau download installer dari https://nodejs.org, lalu buka **ulang** PowerShell dan cek:
```powershell
node -v
npm -v
```

### 2. Masuk ke folder script dan install dependensi
Setelah ekstrak `flop-claim.zip` (misalnya ke `Downloads\flop-claim`):
```powershell
cd $HOME\Downloads\flop-claim
npm install
```

### 3. Cek status faucet & saldo Testnet dulu (tanpa seed phrase)
```powershell
node claim.mjs --check-only
```

### 4. Jalankan klaim
```powershell
node claim.mjs
```
Saat diminta `Enter Talisman 12/24-word mnemonic`, paste atau ketik seed phrase 12/24 kata lalu tekan **Enter** (teks sengaja tidak tampil di layar).

### Opsi tambahan
- Jika `/health` faucet melaporkan `indexer_unavailable` (HTTP 503), tunggu sebentar lalu coba lagi. Jika tetap ingin memaksa kirim request:
  ```powershell
  node claim.mjs --force
  ```
- Jika klaim sempat timeout / error 5xx dan ingin rekonsiliasi ulang tanpa double-claim, pakai ulang `nonce` yang dicetak script:
  ```powershell
  node claim.mjs --nonce <angka_nonce>
  ```
