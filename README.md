# Slug

Watermark remover using MI-GAN and classical inpainting running fully in
the browser.

## Start

    python serve.py - needs python and a browser with WASM

Then open http://localhost:3000.
You can use a different PORT by editing serve.py.

## Workings

Paint a mask over what you wanna remove, then pick a mode:

- **Standard** - instant. OpenCV Telea inpainting, falling back to PatchMatch
  or a harmonic fill when the region suits them better.
- **Pro** - slower, better on texture. Runs MI-GAN (~28MB) in a worker. The
  model is prefetched on your first interaction, but `serve.py` sends
  `max-age=0`, so the browser revalidates it on every use rather than keeping
  it cached.

## Struct

    app/       page layer - main, editor, state, worker client
    workers/   inpaint orchestrator + one module per algorithm
    vendor/    OpenCV and ONNX Runtime builds

Root level:

    migan.onnx   MI-GAN weights for Pro mode, served at /migan.onnx
    serve.py     static file server
    index.html   markup for the single page
    color.css    styles

Editing `workers/lib/` is where you'd tune the algorithms.

## License

MIT licensed, be free.
