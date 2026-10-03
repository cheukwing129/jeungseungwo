/** Keep portraits against the frame; backgrounds retain the original scene coordinates. */
export function pictureStyle(picture, asset, {width = 960, height = 540} = {}) {
  const portrait = picture.asset.startsWith('Half/');
  const scale = portrait ? Math.min(picture.sx / 100, height / asset.height) : picture.sx / 100;
  return {
    left: `${picture.x / width * 100}%`,
    top: portrait ? 'auto' : `${picture.y / height * 100}%`,
    bottom: portrait ? '0px' : 'auto',
    width: `${asset.width * scale / width * 100}%`,
    height: portrait ? 'auto' : `${asset.height * picture.sy / 100 / height * 100}%`,
    objectFit: portrait ? 'contain' : 'fill',
    transform: picture.mirror ? 'scaleX(-1)' : 'none',
  };
}

/** Pending image loads and animation frames always use the latest scene opacity. */
export class PictureRenderer {
  constructor(layer, {
    reducedMotion = false,
    createImage = () => new Image(),
    requestFrame = callback => requestAnimationFrame(callback),
    setTimer = (callback, delay) => setTimeout(callback, delay),
  } = {}) {
    this.layer = layer;
    this.reducedMotion = reducedMotion;
    this.createImage = createImage;
    this.requestFrame = requestFrame;
    this.setTimer = setTimer;
    this.active = new Map();
  }

  reveal(id, image) {
    if (this.active.get(id) === image) image.style.opacity = image.dataset.opacity;
  }

  retire(id, image) {
    this.active.delete(id);
    image.style.opacity = '0';
    this.setTimer(() => image.remove(), this.reducedMotion ? 0 : 250);
  }

  render(pictures, assets, dimensions) {
    for (const [id, image] of this.active) {
      if (!pictures[id] || !assets[pictures[id].asset]) this.retire(id, image);
    }
    for (const [id, picture] of Object.entries(pictures)) {
      const asset = assets[picture.asset];
      if (!asset) continue;
      let image = this.active.get(id);
      if (image && image.dataset.asset !== asset.src) {
        this.retire(id, image);
        image = null;
      }
      const fresh = !image;
      if (fresh) {
        image = this.createImage();
        image.alt = '';
        image.decoding = 'async';
        image.style.opacity = '0';
        image.dataset.asset = asset.src;
        image.addEventListener('load', () => this.reveal(id, image));
        image.src = asset.src;
        this.active.set(id, image);
        this.layer.append(image);
      }
      Object.assign(image.style, pictureStyle(picture, asset, dimensions));
      image.style.zIndex = String(Number(id) || 0);
      image.dataset.opacity = String(Math.max(0, Math.min(255, picture.opacity)) / 255);
      if (fresh && !this.reducedMotion) this.requestFrame(() => this.reveal(id, image));
      else this.reveal(id, image);
    }
  }
}
