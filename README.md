# Mobile Store

An online store for a mobile and electronics shop. Customers browse products, order with cash on delivery, JazzCash or Easypaisa, and track their order. You manage products, stock, orders and shop details from an admin panel.

- **Backend:** Node.js (no packages to install), built-in SQLite database
- **Storefront:** `/`
- **Admin panel:** `/admin`
- Requires **Node.js 22.13 or newer**

## Run it on your computer

1. Install Node.js 22 or newer from nodejs.org.
2. Copy `.env.example` to `.env` and set `ADMIN_PASSWORD`.
3. In this folder run:

   ```
   npm start
   ```
4. Open http://localhost:3000 for the store and http://localhost:3000/admin to sign in.

## First setup (5 minutes)

1. Sign in at `/admin` with your `ADMIN_PASSWORD`.
2. **Shop settings:** enter your shop name, WhatsApp number (with country code, like `923001234567`), JazzCash and Easypaisa numbers, delivery fee and free-delivery amount. Save.
3. **Products:** delete the 12 sample products and add your own, with photos, prices and stock. (Set `SEED_SAMPLES=0` before the first start to skip the samples.)
4. Place a test order on the store, then confirm or cancel it in **Orders**.

## How orders work

1. The customer places an order. The server checks stock, calculates the total from your prices (customers cannot change prices), reduces stock and saves the order.
2. The customer sees an order code and payment instructions, and can message you on WhatsApp with one tap.
3. In **Orders** you see every order. Change the status: New, Confirmed, Shipped, Delivered. Use the WhatsApp button to contact the customer.
4. Cancelling an order puts the items back into stock. A cancelled order cannot be reopened.
5. For JazzCash and Easypaisa, the customer sends the money to your number and shares the screenshot. Check your wallet before confirming the order.

## Put it online

You need a host that runs Node.js 22 or Docker **and has a persistent disk**, because the database and product photos are files. Without a persistent disk, you lose all orders and photos on every restart.

### Option A: a VPS (best value, any provider)

On Ubuntu with Node 22 installed:

```
git clone <your repo> mobile-store && cd mobile-store     # or upload the folder
cp .env.example .env && nano .env                         # set ADMIN_PASSWORD, TRUST_PROXY=1, SEED_SAMPLES=0
npm install -g pm2
pm2 start "node --no-warnings server.js" --name store
pm2 save && pm2 startup
```

Then put Nginx or Caddy in front for HTTPS. With Caddy, this is the whole config:

```
yourdomain.com {
    reverse_proxy localhost:3000
}
```

### Option B: Docker

```
docker build -t mobile-store .
docker run -d --name store -p 3000:3000 -v store-data:/data \
  -e ADMIN_PASSWORD='your-long-password' -e SEED_SAMPLES=0 --restart unless-stopped mobile-store
```

### Option C: Render, Railway or Fly.io

Push this folder to GitHub and create a Docker web service. Attach a persistent disk mounted at `/data`, and set these environment variables: `ADMIN_PASSWORD`, `TRUST_PROXY=1`, `DATA_DIR=/data`, `SEED_SAMPLES=0`. A `render.yaml` is included for Render.

**Always use HTTPS.** The admin sign-in cookie is marked `Secure` automatically when the site is served over HTTPS.

## Backups

Everything lives in the data folder (`data/` by default, or `DATA_DIR`): `store.db` and `uploads/`. Copy that folder regularly, for example once a day. To restore, put the folder back and restart.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Web server, API, admin login, validation, static files |
| `db.js` | Database tables, default settings, sample products |
| `public/index.html`, `store.js`, `store.css` | The customer store |
| `public/admin.html`, `admin.js`, `admin.css` | The admin panel |
| `public/favicon.svg` | Browser tab icon |
| `.env.example` | Settings template (copy to `.env`) |
| `Dockerfile`, `render.yaml` | Deployment files |

## Security notes

- Change `ADMIN_PASSWORD` to something long. After 8 wrong attempts in 15 minutes, sign-in is blocked temporarily for that visitor.
- Orders are limited per visitor per hour to reduce spam.
- Order tracking needs both the order code and the last digits of the phone number.
- Product photos are checked to be real PNG, JPG or WebP images.
- There is one admin account. Keep the password private, and change it by editing `.env` and restarting (this also signs everyone out).

## Good next steps

- Add a domain name and HTTPS (Caddy does this automatically).
- Connect a real payment gateway (JazzCash or Easypaisa merchant API, or PayFast) once your order volume justifies the merchant account.
- Order notifications by WhatsApp Business API or email.
