# Burrow sync server

The sync server stores one encrypted blob per account. The app encrypts everything before uploading it and never sends the key, so the server cannot read your hosts, passwords, keys or snippets.

What the server does see: user names, a SHA-256 hash of each account's login key, the size and time of each upload, and the IP addresses of the devices that connect.

It is a single file (`server.js`) with no dependencies. It needs Node.js 24 or newer for the built-in `node:sqlite`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `DB_PATH` | `./sync.db` | SQLite database file. |
| `REGISTRATION_CODE` | empty | Invite code needed to create an account. Empty turns registration off. |
| `TRUST_PROXY` | off | Set to `1` only when the server can be reached through your reverse proxy alone, and that proxy overwrites `X-Real-IP` with the client's address. The address is used to slow down repeated failed logins. |

The server speaks plain HTTP and has no TLS of its own. Always put it behind a reverse proxy that handles HTTPS, and never expose its port to the internet directly. The app refuses sync servers that don't use HTTPS, except `localhost`.

## Trying it locally

```bash
cd server
REGISTRATION_CODE=test node server.js
```

In the app, go to **Settings → Sync → Create account** and use `http://localhost:3000` as the server and `test` as the invite code.

---

## Running it on a server with Docker

This guide assumes a Linux server that already runs a reverse proxy doing HTTPS for other sites, like Nginx Proxy Manager, Caddy, Traefik or nginx. The sync server gets its own folder, Docker Compose project, internal network and database, and publishes no port. Only the reverse proxy can reach it.

In the commands, replace:

- `USER` with the account you use to log in to the server over SSH
- `SERVER_IP` with the server's IP address (or a host alias from your `~/.ssh/config`)
- `sync.example.com` with the domain you want to use for sync

### Step 1: DNS

At your DNS provider, add an **A** record for `sync` (or whatever name you want) that points to `SERVER_IP`.

New domains often come with A and **AAAA** records that point to the registrar's parking page. Remove those for this name. Either delete the AAAA record or point it at your server's IPv6 address. Otherwise requests over IPv6 end up on the parking page and the proxy can't get a certificate.

Check it from your computer:

```bash
dig +short sync.example.com
```

```bash
dig +short AAAA sync.example.com
```

The first must print your server's IP. The second must print nothing or your server's IPv6 address. Changes can take a few minutes to show up.

### Step 2: Copy the files to the server

`scp` can't use `sudo`, so the files go to your home folder first and are then moved into place as root. From the repository folder on your computer:

```bash
ssh USER@SERVER_IP mkdir -p burrow-sync
```

```bash
scp server/* server/.dockerignore USER@SERVER_IP:~/burrow-sync/
```

`server/*` skips hidden files like a local `.env`, which is why `.dockerignore` is listed on its own.

Then log in to the server and become root. All later commands on the server run as root.

```bash
ssh USER@SERVER_IP
```

```bash
sudo -i
```

Move the files into place and make the folder readable by root only:

```bash
mv /home/USER/burrow-sync /opt/burrow-sync
chown -R root:root /opt/burrow-sync
chmod 700 /opt/burrow-sync
```

Check that Docker Compose v2 is installed:

```bash
docker compose version
```

### Step 3: Find your reverse proxy

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

The container with `0.0.0.0:443->...` under **PORTS** is your proxy. Its **IMAGE** tells you which one it is:

| Image contains | Proxy | Continue at |
|---|---|---|
| `jc21/nginx-proxy-manager` | Nginx Proxy Manager | 5A |
| `caddy` | Caddy | 5B |
| `traefik` | Traefik | 5C |
| `nginx` | nginx | 5D |

The proxy container's name (first column) is called `PROXY` below.

If no container uses port 443, the proxy runs directly on the server. Find out which one:

```bash
systemctl status nginx caddy apache2 --no-pager 2>/dev/null | grep -E '●|Active'
```

In that case skip step 4 and go straight to **5E**.

For 5A to 5D you need the folder that holds the proxy's Compose file, called `PROXY_DIR` below:

```bash
docker inspect PROXY --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
```

If this prints nothing, the proxy wasn't started with Compose and you'll need to attach it to the network from step 4 your own way (`docker network connect burrow-sync PROXY` works until the container is recreated).

To see which config files the proxy reads from the host (left is the path on the server, right is the path in the container):

```bash
docker inspect PROXY --format '{{range .Mounts}}{{.Source}}  ->  {{.Destination}}{{println}}{{end}}'
```

Make a backup copy of every file before you edit it.

### Step 4: Start the sync server

Create an internal network. `--internal` means containers on it can't reach the internet. Only the sync server and your proxy will join it.

```bash
docker network create --internal burrow-sync
```

Create an invite code and start the server:

```bash
cd /opt/burrow-sync
echo "REGISTRATION_CODE=$(openssl rand -hex 16)" > .env
chmod 600 .env
cat .env
docker compose up -d --build
```

Note the code that `cat .env` prints. You need it in step 7.

After about 30 seconds, `docker compose ps` should show `healthy` under STATUS. If it doesn't, `docker compose logs` shows why.

### Step 5: Connect the proxy

Only follow the part for your proxy.

#### For 5A to 5D: add the proxy to the sync network

Open the proxy's Compose file (it may also be called `compose.yml` or `docker-compose.yaml`):

```bash
cd PROXY_DIR
cp docker-compose.yml docker-compose.yml.backup
nano docker-compose.yml
```

Find the proxy's service under `services:`.

If it already has a `networks:` list, add `burrow-sync` to it:

```yaml
  caddy:
    image: caddy:2
    networks:
      - web            # was already there
      - burrow-sync    # new
```

If it has no `networks:` list, add one with **both** `default` and `burrow-sync`. Without `default` the proxy loses its connection to your other services:

```yaml
  caddy:
    image: caddy:2
    networks:
      - default
      - burrow-sync
```

At the bottom of the file, at the top level, declare the network. If a top-level `networks:` block already exists, add just the two inner lines to it:

```yaml
networks:
  burrow-sync:
    external: true
```

Check the file and restart:

```bash
docker compose config --quiet && docker compose up -d
```

An error from `config` usually means wrong indentation (spaces only, no tabs). `cp docker-compose.yml.backup docker-compose.yml` restores the old file.

Check who is on the network. You should see exactly two names, `burrow-sync` and your proxy:

```bash
docker network inspect burrow-sync --format '{{range .Containers}}{{.Name}} {{end}}'
```

#### 5A: Nginx Proxy Manager

1. Open the admin UI, usually `http://SERVER_IP:81`.
2. Go to **Hosts → Proxy Hosts → Add Proxy Host**.
3. On the **Details** tab set Domain Names to `sync.example.com`, Scheme to `http`, Forward Hostname / IP to `burrow-sync`, Forward Port to `3000`, and tick **Block Common Exploits**.
4. On the **SSL** tab choose **Request a new SSL Certificate** and tick **Force SSL** and **HTTP/2 Support**.
5. Save. The certificate is issued within a few seconds.

Nginx Proxy Manager sets `X-Real-IP` to the client's address by default. Continue at step 6.

#### 5B: Caddy

In the mounts output from step 3, find the line whose right side is `/etc/caddy/Caddyfile` (or `/etc/caddy`). The left side is your Caddyfile. Add this block at the end:

```
sync.example.com {
	reverse_proxy burrow-sync:3000 {
		header_up X-Real-IP {remote_host}
	}
}
```

Reload Caddy. It gets the certificate on its own.

```bash
docker exec PROXY caddy reload --config /etc/caddy/Caddyfile
```

Continue at step 6.

#### 5C: Traefik

With Traefik the routing goes on the sync server's container as labels. First find the names of your HTTPS entrypoint and certificate resolver:

```bash
docker inspect PROXY --format '{{range .Args}}{{println .}}{{end}}' | grep -E 'entrypoints|certificatesresolvers'
```

Look for `--entrypoints.NAME.address=:443` (often `websecure`) and `--certificatesresolvers.NAME...` (often `letsencrypt` or `le`). If nothing shows up, they are in a `traefik.yml` in `PROXY_DIR`.

Open `/opt/burrow-sync/docker-compose.yml` and add this right below `container_name: burrow-sync`, with your two names in place of `websecure` and `letsencrypt`:

```yaml
    labels:
      - traefik.enable=true
      - traefik.docker.network=burrow-sync
      - traefik.http.routers.burrow-sync.rule=Host(`sync.example.com`)
      - traefik.http.routers.burrow-sync.entrypoints=websecure
      - traefik.http.routers.burrow-sync.tls.certresolver=letsencrypt
      - traefik.http.services.burrow-sync.loadbalancer.server.port=3000
```

Then restart the sync server with `docker compose up -d` in `/opt/burrow-sync`. Continue at step 6.

#### 5D: nginx in Docker

In the mounts output from step 3, find the line whose right side is `/etc/nginx/conf.d`. The left side is the folder with the site configs. Look at an existing one to see where its certificates come from (`ssl_certificate` and `ssl_certificate_key`), and get a certificate for `sync.example.com` the same way (usually certbot).

Then create `sync.conf` in that folder, using the same certificate path pattern:

```nginx
server {
    listen 80;
    server_name sync.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

    client_max_body_size 6m;

    location / {
        proxy_pass http://burrow-sync:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Test and reload:

```bash
docker exec PROXY nginx -t
```

```bash
docker exec PROXY nginx -s reload
```

nginx refuses to start when it can't resolve `burrow-sync`, so keep the sync server running. Otherwise, after a reboot, your other sites won't come back up either. Continue at step 6.

#### 5E: Proxy installed directly on the server

A proxy outside Docker can't join a Docker network, so here the sync server listens on `127.0.0.1:3100`. Only programs on the server itself can reach that address. Start it with the other Compose file:

```bash
cd /opt/burrow-sync
echo "REGISTRATION_CODE=$(openssl rand -hex 16)" > .env
chmod 600 .env
cat .env
docker compose -f docker-compose.host-proxy.yml up -d --build
```

Note the invite code, then check that it answers:

```bash
curl http://127.0.0.1:3100/api/health
```

It should print `{"ok":true}`. From now on, use `docker compose -f docker-compose.host-proxy.yml ...` wherever this guide says `docker compose ...`.

**nginx:** create `/etc/nginx/sites-available/sync` with:

```nginx
server {
    listen 80;
    server_name sync.example.com;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable it, reload, and get a certificate. certbot adds the HTTPS part to the file for you. Say yes when it asks about redirecting HTTP to HTTPS.

```bash
ln -s /etc/nginx/sites-available/sync /etc/nginx/sites-enabled/sync
nginx -t && systemctl reload nginx
certbot --nginx -d sync.example.com
```

**Caddy:** add this to `/etc/caddy/Caddyfile` and run `systemctl reload caddy`:

```
sync.example.com {
	reverse_proxy 127.0.0.1:3100 {
		header_up X-Real-IP {remote_host}
	}
}
```

**Other proxies** (Apache, HAProxy, ...) work too. They need to serve HTTPS, forward to `http://127.0.0.1:3100`, allow request bodies of at least 6 MB, and overwrite `X-Real-IP` with the client's address.

### Step 6: Check

From your computer:

```bash
curl https://sync.example.com/api/health
```

It should print `{"ok":true}`. If not:

- `Could not resolve host`: the DNS record from step 1 isn't visible yet. Wait a few minutes.
- A certificate error: the proxy has no certificate yet. Wait a moment and check its logs with `docker logs PROXY --tail 50`.
- `502 Bad Gateway`: the proxy can't reach the sync server. For 5A to 5D, check that both are on the `burrow-sync` network.

For 5A to 5D you can also check that other containers can't reach the sync server. Find the network of one of them (`OTHER` is its name from `docker ps`):

```bash
docker inspect OTHER --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

Then try to reach the sync server from that network. This must **fail** with `bad address` or a timeout:

```bash
docker run --rm --network NETWORK_NAME alpine wget -qO- -T 3 http://burrow-sync:3000/api/health
```

If it prints `{"ok":true}`, that container is on the `burrow-sync` network and should be removed from it.

### Step 7: Create accounts

On the first device, open **Settings → Sync → Create account** and enter:

- Server: `https://sync.example.com`
- User name: 3 to 32 characters from a-z, 0-9, dot, underscore and dash
- Account password: a strong password you don't use anywhere else
- Invite code: the code from step 4

On every other device, use **Settings → Sync → Log in** with the same server, user name and password.

Nobody can recover a forgotten account password, not even the server's admin. The data already on your devices stays there, though.

### Step 8: Turn registration off

Once all accounts exist, empty the invite code and restart:

```bash
cd /opt/burrow-sync
echo "REGISTRATION_CODE=" > .env
docker compose up -d
```

Existing accounts keep working. Nobody can create new ones.

---

## Updating

Copy the new files to your home folder on the server as in step 2. Then, on the server as root:

```bash
cp /home/USER/burrow-sync/* /home/USER/burrow-sync/.dockerignore /opt/burrow-sync/
rm -r /home/USER/burrow-sync
cd /opt/burrow-sync
docker compose up -d --build
```

This only replaces the server's code. Your `.env` and the database stay as they are.

## Backups

On the server as root:

```bash
cd /opt/burrow-sync
docker compose exec burrow-sync node backup.js
docker cp burrow-sync:/data/backup-$(date +%F).db /home/USER/
chown USER /home/USER/backup-*.db
```

Then fetch it from your computer:

```bash
scp USER@SERVER_IP:~/backup-*.db .
```

The data in the backup is encrypted and useless without the account passwords.

To follow the logs, run `docker compose logs -f` in `/opt/burrow-sync`.

## What is isolated and what isn't

Separate from your other services:

- **Network:** other containers can't reach the sync server.
- **Data:** its own volume and SQLite database.
- **Configuration:** its own folder and `.env`.
- **Resources:** at most 128 MB of RAM and half a CPU, so it can't slow down anything else.
- **Container:** runs as a non-root user with a read-only file system, no Linux capabilities, no privilege escalation and (except with 5E) no internet access.

Shared with everything else: the reverse proxy, the Docker daemon and the Linux kernel. Containers are not virtual machines. Anyone who gets root on the server can reach everything, but from the sync server they only get encrypted data. If you want the proxy and kernel separated too, run the sync server on its own machine.
