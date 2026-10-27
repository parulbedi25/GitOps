/**
 * Deterministic product artwork.
 *
 * The demo must look good in an air-gapped cluster with no CDN, so the storefront
 * renders its own SVG "product photography": a soft gradient plate per category
 * with a line-art glyph, plus a per-product hue shift derived from the slug. Every
 * product therefore looks related but distinct, and the whole catalogue is a few
 * hundred bytes per image instead of megabytes of JPEGs.
 */

const GLYPHS = {
  audio: `
    <path d="M40 96c0-30 24-54 54-54s54 24 54 54" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    <rect x="26" y="92" width="30" height="52" rx="15" fill="none" stroke="currentColor" stroke-width="4"/>
    <rect x="132" y="92" width="30" height="52" rx="15" fill="none" stroke="currentColor" stroke-width="4"/>
    <circle cx="94" cy="120" r="6" fill="currentColor" opacity=".5"/>`,
  workspace: `
    <rect x="30" y="42" width="128" height="82" rx="8" fill="none" stroke="currentColor" stroke-width="4"/>
    <path d="M94 124v18M70 148h48" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    <path d="M52 92h20M82 92h60" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity=".55"/>`,
  home: `
    <path d="M94 40v30M62 148h64M70 148l-8-56 32-22 32 22-8 56" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M78 92h32" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity=".55"/>`,
  outdoors: `
    <path d="M28 140l40-64 26 40 18-26 32 50z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
    <circle cx="128" cy="58" r="14" fill="none" stroke="currentColor" stroke-width="4" opacity=".7"/>`,
  apparel: `
    <path d="M72 48l-34 20 12 26 20-8v60h48V86l20 8 12-26-34-20-12 8h-20z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
    <path d="M84 48c0 8 4 12 10 12s10-4 10-12" fill="none" stroke="currentColor" stroke-width="4" opacity=".55"/>`,
  accessories: `
    <rect x="46" y="66" width="96" height="62" rx="10" fill="none" stroke="currentColor" stroke-width="4"/>
    <path d="M64 66V54a8 8 0 018-8h44a8 8 0 018 8v12" fill="none" stroke="currentColor" stroke-width="4" opacity=".6"/>
    <path d="M74 96h44" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity=".5"/>`,
};

const PALETTES = {
  audio: ['#1f2937', '#4b5563', '#d1d5db'],
  workspace: ['#3f3a33', '#6b6357', '#e6ddcf'],
  home: ['#7c4a2d', '#b9793f', '#f6e7d3'],
  outdoors: ['#254433', '#3f6b4f', '#d7e6d6'],
  apparel: ['#4a2b3c', '#7d5069', '#efe0e7'],
  accessories: ['#2c3e57', '#4f6a8a', '#dfe7ef'],
};

/** Stable 0-359 hue derived from the slug. */
function hueFor(slug) {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) % 360;
  }
  return hash;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {{slug: string, name: string, category: string}} product
 * @returns {string} SVG document
 */
export function productArtwork({ slug, name, category }) {
  const palette = PALETTES[category] ?? PALETTES.accessories;
  const hue = hueFor(slug);
  const glyph = GLYPHS[category] ?? GLYPHS.accessories;
  const initials = escapeXml(
    (name || slug)
      .split(' ')
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase(),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 188 188" width="188" height="188" role="img" aria-label="${escapeXml(name)}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette[2]}"/>
      <stop offset="100%" stop-color="${palette[1]}" stop-opacity=".55"/>
    </linearGradient>
    <radialGradient id="glow" cx="30%" cy="24%" r="70%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".85"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.045"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="188" height="188" fill="url(#plate)"/>
  <rect width="188" height="188" fill="url(#glow)"/>
  <g transform="rotate(${(hue % 7) - 3} 94 94)" style="color:${palette[0]}" opacity=".92">
    <g transform="translate(0 4) scale(1)">${glyph}</g>
  </g>
  <text x="94" y="172" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="11" letter-spacing="3" fill="${palette[0]}" opacity=".55">${initials}</text>
  <rect width="188" height="188" filter="url(#grain)" opacity=".6"/>
</svg>`;
}

/** Hero artwork: a wider, calmer composition used on the landing page. */
export function heroArtwork() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 560" width="520" height="560" role="img" aria-label="Featured product composition">
  <defs>
    <linearGradient id="heroPlate" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#f3ece2"/>
      <stop offset="55%" stop-color="#e5d9c8"/>
      <stop offset="100%" stop-color="#cbb9a1"/>
    </linearGradient>
    <radialGradient id="heroGlow" cx="28%" cy="18%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".9"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="520" height="560" fill="url(#heroPlate)"/>
  <rect width="520" height="560" fill="url(#heroGlow)"/>
  <circle cx="262" cy="252" r="150" fill="#fbf9f5" opacity=".55"/>
  <g style="color:#2a2520" transform="translate(126 158) scale(1.42)">
    <path d="M40 96c0-30 24-54 54-54s54 24 54 54" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
    <rect x="26" y="92" width="30" height="52" rx="15" fill="none" stroke="currentColor" stroke-width="4"/>
    <rect x="132" y="92" width="30" height="52" rx="15" fill="none" stroke="currentColor" stroke-width="4"/>
  </g>
  <g opacity=".35" stroke="#2a2520" stroke-width="1.5">
    <path d="M0 470h520M0 500h520M0 530h520"/>
  </g>
  <text x="44" y="118" font-family="Georgia, serif" font-size="16" letter-spacing="5" fill="#2a2520" opacity=".5">SHOPSTACK / SS-01</text>
</svg>`;
}
