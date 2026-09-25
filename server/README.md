# Burrow Sync Server auf dem VPS

Der Server speichert pro Konto einen verschlüsselten Datenblock. Verschlüsselt wird in der App, der Server hat keinen Schlüssel und kann nichts lesen.

Er läuft komplett getrennt von deiner Website: eigener Ordner, eigenes Docker-Projekt, eigenes Netz, eigene Datenbank, kein offener Port. Von außen kommt man nur über deinen Reverse Proxy (den Dienst, der schon HTTPS für deine Website macht) an ihn heran.

In den Befehlen ersetzt du:

- `DEINE-VPS-IP` durch die IP deines VPS (steht im IONOS Cloud Panel)
- `sync.deinedomain.de` durch die Subdomain, die du für den Sync nehmen willst

Die Befehle kopierst du einfach ins Terminal und drückst Enter.

---

## Schritt 1: DNS-Eintrag anlegen

1. Im IONOS-Kundenbereich auf **Domains & SSL** gehen und deine Domain anklicken.
2. **DNS** öffnen, **Record hinzufügen**, Typ **A**.
3. Hostname: `sync`, Zeigt auf: `DEINE-VPS-IP`. Speichern.

Du kannst auch eine ganz andere Domain als die deiner Website nehmen. Beide zeigen auf dieselbe VPS-IP, der Proxy unterscheidet sie am Namen. Für die Domain selbst (ohne `sync.` davor) ist der Hostname `@`.

**Achtung bei IONOS:** Neue Domains haben oft schon A- und **AAAA**-Einträge, die auf eine IONOS-Parkseite zeigen. Lösch die alten Einträge für diesen Hostnamen. Einen AAAA-Eintrag entweder löschen oder auf die IPv6-Adresse deines VPS setzen, sonst landen Anfragen per IPv6 auf der Parkseite und es gibt kein Zertifikat.

Das kann ein paar Minuten dauern. Prüfen kannst du es auf deinem Mac mit:

```bash
dig +short sync.deinedomain.de
dig +short AAAA sync.deinedomain.de
```

Beim ersten muss deine VPS-IP rauskommen. Beim zweiten entweder nichts oder die IPv6-Adresse deines VPS.

---

## Schritt 2: Dateien auf den VPS kopieren

Auf deinem **Mac**, im Terminal, im Ordner des Repos (`ssh-client`):

```bash
rsync -av --exclude .env --exclude '*.db' server/ root@DEINE-VPS-IP:/opt/burrow-sync/
```

Das kopiert den Ordner `server` nach `/opt/burrow-sync` auf dem VPS. Falls `rsync` auf dem VPS fehlt, meldet er das. Dann einmal auf dem VPS `apt install rsync` ausführen und nochmal versuchen.

Ab jetzt arbeitest du **auf dem VPS**. Verbinden:

```bash
ssh root@DEINE-VPS-IP
```

Falls du dich nicht als `root` anmeldest, sondern mit einem eigenen Benutzer, schreib vor jeden Befehl ab hier `sudo`.

Den Ordner so einstellen, dass nur root hineinschauen kann:

```bash
chmod 700 /opt/burrow-sync
```

Prüfen, ob Docker Compose da ist:

```bash
docker compose version
```

Da sollte eine Version stehen (v2 oder höher). Wenn "unknown command" kommt, sag mir Bescheid.

---

## Schritt 3: Herausfinden, welcher Proxy bei dir läuft

Der Proxy ist das Programm, das Anfragen an deine Domain annimmt, HTTPS macht und sie an die Website weitergibt. Wir müssen wissen, welches Programm das ist und wo seine Einstellungen liegen.

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Du siehst alle laufenden Container. Such den, bei dem unter **PORTS** `0.0.0.0:443->...` steht. Das ist dein Proxy. Am **IMAGE** erkennst du, welcher es ist:

| Image enthält | Dein Proxy | Weiter bei |
|---|---|---|
| `jc21/nginx-proxy-manager` | Nginx Proxy Manager | Schritt 5A |
| `caddy` | Caddy | Schritt 5B |
| `traefik` | Traefik | Schritt 5C |
| `nginx` | nginx | Schritt 5D |

**Kein Container hat Port 443?** Dann läuft der Proxy direkt auf dem Server und nicht in Docker. Prüf das mit:

```bash
systemctl status nginx caddy apache2 --no-pager 2>/dev/null | grep -E '●|Active'
```

Der Dienst mit `active (running)` ist dein Proxy. Weiter bei **Schritt 5E**.

Merk dir den **Namen** deines Proxy-Containers (erste Spalte), du brauchst ihn gleich. Im Folgenden steht dafür `PROXY`.

### Wo liegen die Dateien des Proxys?

Für 5A bis 5D brauchst du den Ordner, in dem die `docker-compose.yml` des Proxys liegt:

```bash
docker inspect PROXY --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
```

Das gibt einen Pfad aus, z. B. `/root/website`. Das ist der Ordner. Im Folgenden steht dafür `PROXY-ORDNER`.

Wenn da nichts rauskommt, wurde der Proxy ohne Compose gestartet. Dann schick mir die Ausgabe von `docker inspect PROXY` und ich sag dir, wie es weitergeht.

Welche Dateien der Proxy von außen bekommt (z. B. Caddyfile oder nginx-Konfiguration), siehst du so:

```bash
docker inspect PROXY --format '{{range .Mounts}}{{.Source}}  ->  {{.Destination}}{{println}}{{end}}'
```

Links steht der Pfad auf deinem VPS (den bearbeitest du), rechts der Pfad im Container.

### Kurz: Dateien bearbeiten mit nano

```bash
nano /pfad/zur/datei
```

Mit den Pfeiltasten bewegen, ganz normal tippen. **Speichern:** `Ctrl+O`, dann `Enter`. **Beenden:** `Ctrl+X`.

Bevor du eine Datei änderst, mach eine Sicherungskopie:

```bash
cp /pfad/zur/datei /pfad/zur/datei.backup
```

---

## Schritt 4: Sync-Server starten

**Wenn du in Schritt 3 bei 5E gelandet bist** (Proxy läuft direkt auf dem Server), geh direkt zu **Schritt 5E**. Dort startest du den Server anders.

Für alle anderen:

```bash
docker network create --internal burrow-sync
```

Das legt ein eigenes Netz an. `--internal` heißt, was darin hängt, kommt nicht ins Internet. Nur der Sync-Server und dein Proxy kommen da rein, die Website nicht.

Dann den Einladungscode erzeugen und starten:

```bash
cd /opt/burrow-sync
echo "REGISTRATION_CODE=$(openssl rand -hex 16)" > .env
chmod 600 .env
cat .env
docker compose up -d --build
```

**Schreib dir den Code aus `cat .env` auf**, den brauchst du in Schritt 7.

Nach etwa 30 Sekunden:

```bash
docker compose ps
```

Unter STATUS muss `healthy` stehen. Wenn nicht: `docker compose logs` und mir die Ausgabe schicken.

---

## Schritt 5: Proxy anbinden

Mach nur den Unterpunkt, der zu deinem Proxy passt.

### Bei 5A bis 5D zuerst: Proxy ins Sync-Netz hängen

Das gilt für alle Proxys in Docker. Öffne die Compose-Datei des Proxys:

```bash
cd PROXY-ORDNER
ls
cp docker-compose.yml docker-compose.yml.backup
nano docker-compose.yml
```

(Falls die Datei bei `ls` anders heißt, z. B. `compose.yml` oder `docker-compose.yaml`, nimm diesen Namen.)

In der Datei findest du unter `services:` den Eintrag für den Proxy (z. B. `npm:`, `caddy:`, `traefik:` oder `nginx:`). Da passiert Folgendes:

**Fall 1: Der Proxy-Eintrag hat schon eine Zeile `networks:`.** Füg darunter `- burrow-sync` als weiteren Eintrag an:

```yaml
  caddy:
    image: caddy:2
    networks:
      - web            # war schon da
      - burrow-sync    # neu
```

**Fall 2: Der Proxy-Eintrag hat keine Zeile `networks:`.** Füg beide Zeilen hinzu, **auch `default`**. Sonst verliert der Proxy die Verbindung zu deiner Website:

```yaml
  caddy:
    image: caddy:2
    networks:
      - default        # wichtig, damit die Website erreichbar bleibt
      - burrow-sync
```

Achte auf die Einrückung: `networks:` steht auf derselben Höhe wie `image:`, die Einträge darunter zwei Leerzeichen weiter rechts. Keine Tabs, nur Leerzeichen.

**Dann ganz unten in der Datei** (ganz links, ohne Einrückung). Wenn es schon einen Block `networks:` ganz links gibt, häng nur die zwei Zeilen `burrow-sync:` und `external: true` darunter:

```yaml
networks:
  burrow-sync:
    external: true
```

Speichern, dann prüfen und neu starten:

```bash
docker compose config --quiet && docker compose up -d
```

Wenn `config` einen Fehler meldet, ist meistens die Einrückung falsch. Mit `cp docker-compose.yml.backup docker-compose.yml` kommst du zurück zum alten Stand.

Prüfen, ob der Proxy den Sync-Server jetzt sieht:

```bash
docker network inspect burrow-sync --format '{{range .Containers}}{{.Name}} {{end}}'
```

Da müssen genau zwei Namen stehen: `burrow-sync` und dein Proxy. Deine Website darf hier **nicht** auftauchen.

Jetzt weiter mit dem Unterpunkt für deinen Proxy.

### 5A: Nginx Proxy Manager

Nginx Proxy Manager wird über eine Weboberfläche bedient, nicht über Dateien.

1. Öffne im Browser die Oberfläche. Das ist meist `http://DEINE-VPS-IP:81` (in `docker ps` steht der Port bei `...->81/tcp`).
2. **Hosts → Proxy Hosts → Add Proxy Host**.
3. Tab **Details**:
   - Domain Names: `sync.deinedomain.de`
   - Scheme: `http`
   - Forward Hostname / IP: `burrow-sync`
   - Forward Port: `3000`
   - **Block Common Exploits** anhaken
4. Tab **SSL**: **Request a new SSL Certificate**, **Force SSL** und **HTTP/2 Support** anhaken, E-Mail eintragen, Bedingungen akzeptieren.
5. **Save**. Das Zertifikat holt er sich selbst, das dauert ein paar Sekunden.

Weiter bei Schritt 6.

### 5B: Caddy

Such in der Ausgabe von `docker inspect PROXY --format ...Mounts...` (Schritt 3) die Zeile, die rechts auf `/etc/caddy/Caddyfile` zeigt. Links steht dein Caddyfile. (Zeigt sie rechts nur auf `/etc/caddy`, liegt das Caddyfile im Ordner links.) Öffnen:

```bash
cp /pfad/zum/Caddyfile /pfad/zum/Caddyfile.backup
nano /pfad/zum/Caddyfile
```

Ganz unten einen neuen Block einfügen:

```
sync.deinedomain.de {
	reverse_proxy burrow-sync:3000 {
		header_up X-Real-IP {remote_host}
	}
}
```

Speichern, dann Caddy die neue Datei laden lassen:

```bash
docker exec PROXY caddy reload --config /etc/caddy/Caddyfile
```

Kein Fehler heißt: fertig. Das HTTPS-Zertifikat holt Caddy sich selbst. Weiter bei Schritt 6.

### 5C: Traefik

Bei Traefik trägst du die Weiterleitung beim Sync-Server ein, nicht beim Proxy. Zuerst herausfinden, wie bei dir der HTTPS-Eingang und der Zertifikat-Dienst heißen:

```bash
docker inspect PROXY --format '{{range .Args}}{{println .}}{{end}}' | grep -E 'entrypoints|certificatesresolvers'
```

Du suchst zwei Namen: bei `--entrypoints.NAME.address=:443` den Namen des Eingangs (oft `websecure`), und bei `--certificatesresolvers.NAME...` den Namen des Zertifikat-Dienstes (oft `letsencrypt` oder `le`). Kommt nichts raus, steht es in einer `traefik.yml` im PROXY-ORDNER.

Dann die Compose-Datei des Sync-Servers öffnen:

```bash
cd /opt/burrow-sync
nano docker-compose.yml
```

Direkt unter der Zeile `container_name: burrow-sync` einfügen, mit deinen zwei Namen statt `websecure` und `letsencrypt`:

```yaml
    labels:
      - traefik.enable=true
      - traefik.docker.network=burrow-sync
      - traefik.http.routers.burrow-sync.rule=Host(`sync.deinedomain.de`)
      - traefik.http.routers.burrow-sync.entrypoints=websecure
      - traefik.http.routers.burrow-sync.tls.certresolver=letsencrypt
      - traefik.http.services.burrow-sync.loadbalancer.server.port=3000
```

Speichern und neu starten:

```bash
docker compose up -d
```

Weiter bei Schritt 6.

### 5D: nginx in Docker

Such in der Mounts-Ausgabe aus Schritt 3 die Zeile, die rechts auf `/etc/nginx/conf.d` zeigt. Links steht der Ordner mit den Seiten-Konfigurationen. Schau dir die bestehende Datei deiner Website an:

```bash
ls /pfad/zu/conf.d
cat /pfad/zu/conf.d/DEINE-WEBSITE.conf
```

Achte auf die Zeilen `ssl_certificate` und `ssl_certificate_key`. Daran siehst du, woher deine Zertifikate kommen.

Für die neue Subdomain brauchst du ein eigenes Zertifikat. Wie du das bekommst, hängt davon ab, wie deine Website ihres bekommt (meist certbot). **Wenn du dir hier unsicher bist, schick mir den Inhalt der Website-Konfiguration** (ohne private Schlüssel, die stehen da sowieso nicht drin) und ich schreib dir die genauen Befehle.

Hast du das Zertifikat, neue Datei anlegen:

```bash
nano /pfad/zu/conf.d/sync.conf
```

Inhalt, mit den Zertifikatspfaden nach demselben Muster wie bei deiner Website:

```nginx
server {
    listen 80;
    server_name sync.deinedomain.de;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name sync.deinedomain.de;

    ssl_certificate     /etc/letsencrypt/live/sync.deinedomain.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.deinedomain.de/privkey.pem;

    client_max_body_size 6m;

    location / {
        proxy_pass http://burrow-sync:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Testen und neu laden:

```bash
docker exec PROXY nginx -t
docker exec PROXY nginx -s reload
```

`nginx -t` muss `syntax is ok` und `test is successful` sagen. Sonst mit `rm /pfad/zu/conf.d/sync.conf` die Datei wieder löschen und mir die Fehlermeldung schicken.

Wichtig: nginx startet nur, wenn `burrow-sync` erreichbar ist. Lass den Sync-Server also immer laufen, sonst startet nach einem Neustart auch deine Website nicht.

Weiter bei Schritt 6.

### 5E: Proxy läuft direkt auf dem Server (ohne Docker)

Hier kann der Proxy kein Docker-Netz betreten. Deshalb lauscht der Sync-Server auf `127.0.0.1:3100`. Das ist nur vom Server selbst aus erreichbar, nicht aus dem Internet und nicht aus anderen Containern.

Starten (statt Schritt 4):

```bash
cd /opt/burrow-sync
echo "REGISTRATION_CODE=$(openssl rand -hex 16)" > .env
chmod 600 .env
cat .env
docker compose -f docker-compose.host-proxy.yml up -d --build
```

Code aus `cat .env` aufschreiben. Prüfen:

```bash
curl http://127.0.0.1:3100/api/health
```

Muss `{"ok":true}` liefern.

**Wenn dein Proxy nginx ist:** Neue Datei anlegen:

```bash
nano /etc/nginx/sites-available/sync
```

Inhalt:

```nginx
server {
    listen 80;
    server_name sync.deinedomain.de;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Aktivieren, testen, neu laden und das Zertifikat holen:

```bash
ln -s /etc/nginx/sites-available/sync /etc/nginx/sites-enabled/sync
nginx -t && systemctl reload nginx
certbot --nginx -d sync.deinedomain.de
```

certbot trägt HTTPS selbst in die Datei ein und fragt, ob HTTP auf HTTPS umgeleitet werden soll: ja. Falls `certbot` fehlt: `apt install certbot python3-certbot-nginx`.

**Wenn dein Proxy Caddy ist:** In `/etc/caddy/Caddyfile` unten einfügen und `systemctl reload caddy`:

```
sync.deinedomain.de {
	reverse_proxy 127.0.0.1:3100 {
		header_up X-Real-IP {remote_host}
	}
}
```

**Apache:** Sag mir Bescheid, dann schreib ich dir das passend.

Bei 5E gilt ab jetzt überall: statt `docker compose ...` immer `docker compose -f docker-compose.host-proxy.yml ...`.

---

## Schritt 6: Prüfen

Auf deinem **Mac**:

```bash
curl https://sync.deinedomain.de/api/health
```

Muss `{"ok":true}` liefern. Wenn nicht:

- `Could not resolve host`: DNS aus Schritt 1 ist noch nicht da. Ein paar Minuten warten.
- Zertifikatsfehler: Der Proxy hat noch kein Zertifikat. Bei 5A bis 5C kurz warten und die Proxy-Logs anschauen (`docker logs PROXY --tail 50`).
- `502 Bad Gateway`: Der Proxy erreicht den Sync-Server nicht. Bei 5A bis 5D prüfen, ob beide im Netz `burrow-sync` hängen (siehe Ende von "Proxy ins Sync-Netz hängen").

**Trennung von der Website prüfen** (nicht bei 5E). Auf dem VPS herausfinden, in welchem Netz die Website hängt (`WEBSITE` ist der Name deines Website-Containers aus `docker ps`):

```bash
docker inspect WEBSITE --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

Mit diesem Netznamen testen, ob man von dort an den Sync-Server kommt. **Das muss fehlschlagen** (`bad address` oder Timeout):

```bash
docker run --rm --network NETZNAME alpine wget -qO- -T 3 http://burrow-sync:3000/api/health
```

Wenn stattdessen `{"ok":true}` kommt, hängt die Website mit im Sync-Netz. Dann schick mir die Ausgabe.

---

## Schritt 7: In der App anmelden

Auf dem **ersten Gerät**: **Settings → Sync → Create account**.

- Server: `https://sync.deinedomain.de`
- User name: frei wählbar, z. B. `ben`
- Account password: ein starkes Passwort, das du nirgends sonst benutzt
- Invite code: der Code aus Schritt 4

Auf **allen anderen Geräten**: **Settings → Sync → Log in** mit demselben Server, Namen und Passwort.

Ein vergessenes Konto-Passwort kann niemand wiederherstellen, auch du auf dem Server nicht. Die Daten auf deinen Geräten bleiben dann aber da.

---

## Schritt 8: Registrierung schließen

Wenn alle Konten angelegt sind, auf dem VPS:

```bash
cd /opt/burrow-sync
echo "REGISTRATION_CODE=" > .env
docker compose up -d
```

(Bei 5E: `docker compose -f docker-compose.host-proxy.yml up -d`.)

Bestehende Konten funktionieren weiter, neue kann niemand mehr anlegen.

---

## Später

**Update**, wenn sich der Server-Code im Repo geändert hat: auf dem Mac den `rsync`-Befehl aus Schritt 2 nochmal ausführen (deine `.env` auf dem VPS bleibt unangetastet), dann auf dem VPS:

```bash
cd /opt/burrow-sync
docker compose up -d --build
```

**Backup:**

```bash
cd /opt/burrow-sync
docker compose exec burrow-sync node backup.js
docker cp burrow-sync:/data/backup-$(date +%F).db .
```

Die Datei liegt dann in `/opt/burrow-sync`. Auf deinen Mac holen (auf dem Mac ausführen):

```bash
scp root@DEINE-VPS-IP:/opt/burrow-sync/backup-*.db .
```

Das Backup ist verschlüsselt und ohne die Konto-Passwörter wertlos.

**Logs anschauen:** `docker compose logs -f` (beenden mit `Ctrl+C`).

---

## Was getrennt ist und was nicht

**Getrennt von der Website:**

- **Netz:** Die Website kann den Container nicht erreichen.
- **Daten:** eigenes Volume, eigene SQLite-Datenbank.
- **Konfiguration:** eigener Ordner, eigene `.env`.
- **Ressourcen:** höchstens 128 MB RAM und eine halbe CPU, damit der Container die Website nie ausbremst.
- **Container selbst:** läuft ohne root, mit schreibgeschütztem Dateisystem, ohne Linux-Capabilities und (außer bei 5E) ohne Internetzugang.

**Gemeinsam bleiben** der Reverse Proxy, der Docker-Dienst und der Linux-Kernel. Container sind keine virtuellen Maschinen. Wer auf dem VPS root wird, kommt an alles, sieht vom Sync aber nur verschlüsselte Daten. Wenn auch Proxy und Kernel getrennt sein sollen, geht das nur mit einem zweiten VPS.
