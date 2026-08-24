# `earth-data` Worker

Serves the R2 bucket over HTTP/2 + HTTP/3 with edge caching, replacing direct reads of the
`r2.dev` public endpoint. The reasoning, the measurements and the brotli fallback are all in
the header comment of [`index.js`](index.js); deployment is in the root README under
"Serving the bucket through a Worker".

```sh
cd worker && npx wrangler deploy      # browser OAuth on first run
npx wrangler tail                     # live request log, to confirm cache HITs
```

Nothing in the refresh loop touches this: `upload_data.sh` and `upload_textures.sh` keep
writing to the bucket over the S3 API, and the Worker reads whatever is there.
