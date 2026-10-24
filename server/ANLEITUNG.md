# Neon Vortex auf dem Raspberry Pi

Der Server liefert das Spiel aus und speichert **Konten und Spielstände** auf dem Pi.
Er braucht nur **Node.js**, sonst nichts.

## Was er kann

- Konto erstellen, anmelden, abmelden
- Spielstand wird automatisch gespeichert (nach jedem Lauf und bei Änderungen im Menü)
- **Kein Name doppelt:** Gross/Klein zählt nicht („Marco“ = „marco“), auch Leerzeichen am Rand nicht
- **Sonderzeichen:** Namen dürfen Buchstaben aus allen Sprachen (ä, ö, ü, é, ß …), Zahlen, Leerzeichen und `_ - .` enthalten, 3 bis 16 Zeichen.
  Zeichen wie `< > / \ " '` und Emojis sind nicht erlaubt. Passwörter dürfen jedes Zeichen enthalten (mindestens 6).
- Passwörter werden nur gehasht gespeichert (scrypt), nie im Klartext
- Schutz gegen Passwort-Raten: nach 10 Fehlversuchen ist die IP 15 Minuten gesperrt
- Höchstens 5 neue Konten pro Stunde und IP

## Installation

```bash
sudo apt update
sudo apt install -y nodejs git
node --version          # muss 18 oder neuer sein
cd ~
git clone https://github.com/Marcopolo234231/neonvortex.git
node neonvortex/server/server.js
```

Dann im Browser (im gleichen WLAN): `http://<IP-vom-Pi>:8080`
Die IP findest du mit `hostname -I`.

## Automatisch starten

```bash
mkdir -p ~/neonvortex-daten
sudo cp ~/neonvortex/server/neonvortex.service /etc/systemd/system/
sudo systemctl enable --now neonvortex
systemctl status neonvortex      # sollte "active (running)" zeigen
```

Heisst dein Benutzer nicht `pi`, ändere `User=` und die Pfade in der Datei.

## Update einspielen

```bash
cd ~/neonvortex && git pull && sudo systemctl restart neonvortex
```

Die Spielstände liegen in `~/neonvortex-daten` und bleiben bei Updates erhalten.

## SD-Karte schonen

Der Server schreibt sehr wenig: eine kleine Datei pro Konto, nur wenn sich etwas ändert.
Was sonst am meisten auf die SD-Karte schreibt, kannst du so abstellen:

1. **Systemlogs nur im RAM:** in `/etc/systemd/journald.conf` die Zeile `Storage=volatile` setzen, dann `sudo systemctl restart systemd-journald`
2. **Swap aus:** `sudo systemctl disable --now dphys-swapfile` (nur wenn der Pi genug RAM hat, z. B. 2 GB oder mehr)
3. **Am besten:** die Daten auf einen **USB-Stick oder eine USB-SSD** legen, z. B. `NV_DATA=/mnt/usb/neonvortex-daten` in der Service-Datei

Wichtig: Das **Overlay-Dateisystem** (read-only) aus `raspi-config` geht hier nicht, sonst sind die Spielstände nach einem Neustart weg.
Ausser du legst `NV_DATA` auf einen USB-Stick.

## Backup

Einfach den Ordner kopieren:

```bash
tar czf neonvortex-backup.tgz -C ~ neonvortex-daten
```

## Über GitHub spielen, auf dem Pi speichern

Das Spiel kann auf GitHub Pages bleiben (https://marcopolo234231.github.io/neonvortex/) und trotzdem auf dem Pi speichern.
Dafür muss der Pi eine **HTTPS-Adresse** aus dem Internet haben. Am einfachsten und gratis geht das mit **Tailscale Funnel**.
Du brauchst dafür keine Router-Einstellungen und keine eigene Domain.

1. Konto auf https://tailscale.com erstellen (gratis)
2. Auf dem Pi:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up            # Link im Browser öffnen und anmelden
   sudo tailscale funnel --bg 8080
   ```
   Falls Funnel noch nicht freigeschaltet ist, zeigt der Befehl einen Link. Öffne ihn und klicke auf „Enable“.
3. Der Befehl zeigt deine Adresse, z. B. `https://raspberrypi.tail1234.ts.net`. Die bleibt immer gleich.
4. In der Service-Datei zusätzlich `Environment=TRUST_PROXY=1` setzen, dann:
   ```bash
   sudo systemctl daemon-reload && sudo systemctl restart neonvortex
   ```
5. Auf GitHub im Repo die Datei **`config.json`** bearbeiten (Stift-Symbol) und deine Adresse eintragen:
   ```json
   { "server": "https://raspberrypi.tail1234.ts.net" }
   ```
   Speichern („Commit changes“). Nach 1 bis 2 Minuten ist es live.

Das Spiel auf GitHub zeigt jetzt Login und Registrieren, und alles wird auf dem Pi gespeichert.
**Ist der Pi aus**, spielt man automatisch mit lokalen Profilen weiter und bekommt einen Hinweis.

Läuft das Spiel auf einer anderen Adresse als `https://marcopolo234231.github.io`, setze sie in der Service-Datei mit
`Environment=ALLOW_ORIGINS=https://deine-adresse` (mehrere mit Komma trennen).

### Wenn die Adresse nicht gefunden wird

- `tailscale status` zeigt unten „Tailscale can't reach the configured DNS servers“: `sudo tailscale set --accept-dns=false` und `sudo systemctl restart NetworkManager`
- Der Pi heisst bei Tailscale `name-1`: Das alte Gerät auf https://login.tailscale.com/admin/machines löschen und den Pi umbenennen. Danach `sudo tailscale funnel reset` und `sudo tailscale funnel --bg 8080`
- Testen mit `nslookup <adresse> 1.1.1.1`: Erst wenn dort IP-Adressen stehen, ist die Adresse im Internet erreichbar

### Alternative: Cloudflare Tunnel

Das geht auch, für eine feste Adresse braucht es aber eine eigene Domain (ca. 10 CHF pro Jahr). Auch hier `TRUST_PROXY=1` setzen.

## Nur zu Hause

Im WLAN geht `http://<IP-vom-Pi>:8080` sofort, ohne Tailscale.
