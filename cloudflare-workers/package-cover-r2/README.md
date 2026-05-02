# Package cover uploads → Cloudflare R2

Bouquet cover files from the Lumina admin UI can be stored on **Cloudflare R2** instead of Supabase Storage.

## 1. R2 bucket

1. Cloudflare Dashboard → **R2** → Create bucket (e.g. `lumina-package-covers`).
2. Enable **public access** for that bucket (R2.dev subdomain or a custom domain) so `cover_url` in Supabase is a normal `https://…` image URL.
3. Copy the public base URL (no trailing slash), e.g. `https://pub-xxxxx.r2.dev`.

## 2. Worker

1. Edit `wrangler.toml`: set `bucket_name` and `[vars] PUBLIC_BASE_URL` to that public base.
2. From this folder:

   ```bash
   npx wrangler login
   npx wrangler secret put UPLOAD_SECRET
   ```

   Choose a long random string; you will reuse it as `VITE_CLOUDFLARE_COVER_UPLOAD_SECRET` in the app (it is sent as `Authorization: Bearer …` from the browser, like your existing admin key — restrict who can use your build).

3. Deploy:

   ```bash
   npx wrangler deploy
   ```

4. Note the Worker URL, e.g. `https://lumina-package-cover-upload.your-account.workers.dev`.

## 3. App `.env`

```env
VITE_CLOUDFLARE_COVER_UPLOAD_URL=https://lumina-package-cover-upload.your-account.workers.dev
VITE_CLOUDFLARE_COVER_UPLOAD_SECRET=the_same_value_as_UPLOAD_SECRET
```

Rebuild the app. When `VITE_CLOUDFLARE_COVER_UPLOAD_URL` is set, uploads go to R2; Supabase still stores only the final `cover_url` string.

If these variables are **unset**, behaviour is unchanged: uploads use Supabase Storage bucket `package-covers`.
