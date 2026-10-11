# Slug

Watermark remover using MI-GAN and classical inpainting running fully in
the browser.

## Start

    python serve.py

Needs Python 3 and a browser with WASM. Then open http://localhost:3000, or
pick another port with `PORT=8080 python serve.py`. If the port is taken the
server tries the next ones and prints the address it got. Any static host
works too, at the domain root or under a subpath, but Pro only gets multiple
threads where the host sends the same COOP/COEP headers as `serve.py`.

## Workings

Paint a mask over what you wanna remove, then pick a mode:

- **Standard** - instant. OpenCV Telea inpainting, with a pure-JS harmonic
  fill as the fallback if OpenCV fails to load.
- **Pro** - slower, better on texture. Runs MI-GAN (~28MB) in a worker, on
  about half your CPU's threads (up to 6). The model starts loading as soon
  as an image is open in Pro mode. `serve.py` sends `max-age=0`, so the
  browser revalidates it rather than re-downloading.

The fill runs on a copy capped at 2048px a side and is feathered back into
the full-resolution image, so pixels away from the mask are never touched.

## Struct

    app/       page layer - main, editor, history, worker client
    workers/   inpaint orchestrator + one module per algorithm
    vendor/    OpenCV and ONNX Runtime builds

Root level:

    migan.onnx   MI-GAN weights for Pro mode
    serve.py     static file server
    index.html   markup for the single page
    color.css    styles

Editing `workers/lib/` is where you'd tune the algorithms.

## License

MIT licensed, be free.
