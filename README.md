# 1065 Park 13AB — living room 3D mock-up

Directional design tool for the 13AB living room: swap wall finishes, floor, fireplace surround,
fabrics and lighting; drag furniture; add real products from links; save shared versions.

- `index.html` — the whole app (three.js from CDN)
- `api/data.js` — shared saved versions + items (Vercel Blob, private store, `BLOB_READ_WRITE_TOKEN`)
- `api/meta.js` — reads a product link (title, photo, price, dimensions where published)
- `api/img.js` — image proxy so product photos can be used as textures

Deploy: import this repo in Vercel (framework: Other), then Storage → Create → Blob (private) and connect it to the project. Redeploy once.
