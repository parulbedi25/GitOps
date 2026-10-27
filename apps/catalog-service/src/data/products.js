/**
 * Catalogue seed data.
 *
 * This is what a fresh reference cluster boots with. A production database would
 * hold the same rows (see `migrations/001_schema.sql`); keeping the seed in code
 * means `gitops` can rebuild the whole demo from nothing and the storefront is
 * never empty.
 *
 * Money is integer cents, always. Prices are edited by finance, not by computing
 * `19.99 + 0.01` in IEEE-754.
 */

export const categories = [
  { slug: 'audio', name: 'Audio' },
  { slug: 'workspace', name: 'Workspace' },
  { slug: 'outdoor', name: 'Outdoor' },
  { slug: 'home', name: 'Home' },
  { slug: 'kitchen', name: 'Kitchen' },
  { slug: 'apparel', name: 'Apparel' },
  { slug: 'accessories', name: 'Accessories' },
  { slug: 'travel', name: 'Travel' },
];

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const product = (id, name, category, priceCents, stock, rating, reviewCount, description, tags = [], featured = false) => ({
  id,
  slug: slugify(name),
  name,
  description,
  category,
  priceCents,
  currency: 'USD',
  stock,
  rating,
  reviewCount,
  tags,
  featured,
});

export const products = [
  // ── Audio ────────────────────────────────────────────────────────────────
  product('sku-1001', 'Atlas ANC Headphones', 'audio', 27900, 42, 4.8, 1284,
    'Adaptive noise cancelling over-ears with 40-hour battery life and a replaceable earcup kit.',
    ['wireless', 'noise-cancelling'], true),
  product('sku-1002', 'Orbit Open Earbuds', 'audio', 14900, 0, 4.4, 512,
    'Open-ear buds that keep you aware of traffic while you run. Sweat resistant, 9-hour charge.',
    ['wireless', 'sport']),
  product('sku-1003', 'Lumen Portable Speaker', 'audio', 9900, 31, 4.6, 208,
    'A palm-sized speaker with a machined aluminium body and a surprisingly deep low end.',
    ['bluetooth', 'portable']),

  // ── Workspace ────────────────────────────────────────────────────────────
  product('sku-1004', 'Alto Mechanical Keyboard', 'workspace', 17900, 18, 4.7, 902,
    '75% hot-swappable keyboard with a gasket mount and a CNC aluminium case.',
    ['mechanical', 'usb-c'], true),
  product('sku-1005', 'Trellis Monitor Arm', 'workspace', 8900, 26, 4.5, 341,
    'Gas-spring arm that holds up to 9kg at full extension without a wobble.',
    ['desk', 'ergonomic']),
  product('sku-1006', 'Daybreak Desk Lamp', 'workspace', 11900, 24, 4.6, 187,
    'Tunable white LED lamp with a 96 CRI panel and a weighted brass base.',
    ['lighting', 'desk']),
  product('sku-1007', 'Ledger Desk Pad', 'workspace', 5900, 64, 4.3, 233,
    'Full-grain leather desk mat with a cork backing and a stitched edge.',
    ['leather', 'desk']),
  product('sku-1008', 'Glide Ergonomic Mouse', 'workspace', 7900, 4, 4.3, 288,
    'Vertical grip mouse that takes the twist out of your forearm.',
    ['ergonomic', 'wireless']),

  // ── Outdoor ──────────────────────────────────────────────────────────────
  product('sku-1009', 'Ridge Trail Backpack 24L', 'outdoor', 13900, 22, 4.7, 411,
    '24-litre ripstop pack with a roll-top closure and a floating hip belt.',
    ['hiking', 'ripstop']),
  product('sku-1010', 'Basin Water Filter', 'outdoor', 6900, 37, 4.5, 156,
    'Gravity filter that turns 8 litres of stream water into drinking water in four minutes.',
    ['camping', 'water']),
  product('sku-1011', 'Ember Pocket Stove', 'outdoor', 5400, 45, 4.4, 189,
    'Titanium canister stove that boils 500ml in two and a half minutes.',
    ['camping', 'titanium']),
  product('sku-1014', 'Summit Insulated Bottle', 'outdoor', 3900, 140, 4.6, 1876,
    'Double-walled 750ml bottle: 24 hours cold, 12 hours hot, and it fits a bike cage.',
    ['insulated', 'steel'], true),

  // ── Home ─────────────────────────────────────────────────────────────────
  product('sku-1012', 'Haven Linen Throw', 'home', 8900, 29, 4.5, 96,
    'Stonewashed linen throw that softens with every wash. 130 × 170 cm.',
    ['linen', 'textiles']),
  product('sku-1013', 'Quarry Ceramic Vase', 'home', 4900, 51, 4.2, 74,
    'Hand-thrown stoneware vase with a matte glaze and a narrow neck.',
    ['ceramic', 'decor']),
  product('sku-1015', 'Vesper Candle Set', 'home', 4400, 88, 4.6, 302,
    'Three soy-wax candles: cedar, fig leaf and smoked vanilla. 40-hour burn each.',
    ['candles', 'gift']),
  product('sku-1016', 'Tessellate Wool Rug', 'home', 24900, 6, 4.7, 58,
    'Hand-tufted wool rug in a geometric pattern, 160 × 230 cm.',
    ['wool', 'rug']),

  // ── Kitchen ──────────────────────────────────────────────────────────────
  product('sku-1017', 'Forge Chef Knife 8"', 'kitchen', 12900, 33, 4.8, 264,
    'Forged high-carbon steel blade with a pakkawood handle and a 58 HRC edge.',
    ['knife', 'steel'], true),
  product('sku-1018', 'Copper Pour-Over Kettle', 'kitchen', 8400, 47, 4.6, 391,
    'Gooseneck kettle with a counterweighted handle for a slow, controlled pour.',
    ['coffee', 'copper']),
  product('sku-1019', 'Grid Cast Iron Skillet', 'kitchen', 7400, 39, 4.8, 812,
    'Pre-seasoned 10-inch skillet that gets better every single time you use it.',
    ['cast-iron', 'cookware']),
  product('sku-1020', 'Hearth Stoneware Mugs (4)', 'kitchen', 4800, 92, 4.4, 176,
    'Four hand-glazed stoneware mugs, dishwasher and microwave safe.',
    ['ceramic', 'gift']),

  // ── Apparel ──────────────────────────────────────────────────────────────
  product('sku-1021', 'Merino Trail Crew', 'apparel', 12900, 55, 4.7, 218,
    'Featherweight merino crew that regulates temperature on the move and resists odour.',
    ['merino', 'hiking']),
  product('sku-1022', 'Storm Shell Jacket', 'apparel', 22900, 12, 4.8, 96,
    'Three-layer shell with taped seams, a helmet-compatible hood and pit zips.',
    ['waterproof', 'shell']),

  // ── Accessories ──────────────────────────────────────────────────────────
  product('sku-1023', 'Cable Travel Pouch', 'accessories', 2900, 120, 4.1, 88,
    'Felt-lined pouch that keeps cables, adapters and a power bank in one place.',
    ['travel', 'organiser']),
  product('sku-1024', 'Harbour Knit Beanie', 'accessories', 3400, 76, 4.5, 233,
    'Ribbed lambswool beanie with a folded cuff and a brushed lining.',
    ['wool', 'winter']),

  // ── Travel ───────────────────────────────────────────────────────────────
  product('sku-1025', 'Voyage Duffel 40L', 'travel', 15900, 2, 4.9, 143,
    'Weatherproof 40-litre duffel with a lay-flat opening and a removable strap.',
    ['carry-on', 'waterproof']),
  product('sku-1026', 'Transit Packing Cubes', 'travel', 4400, 110, 4.4, 407,
    'Three compression cubes that fit a carry-on and keep a week of clothes in order.',
    ['travel', 'organiser']),
];

export default products;
