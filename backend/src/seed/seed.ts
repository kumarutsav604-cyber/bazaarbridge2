import bcrypt from 'bcryptjs';
import { env } from '../config/env.ts';
import { closePool, getPool, isPgConfigured } from '../db/pool.ts';
import { ensureIndex, isOpenSearchConfigured, upsertOffer } from '../search/index.ts';

const PRODUCT_IMAGES = [
  '/src/assets/images/product_bluetooth_speaker_1795284935195.jpg',
  '/src/assets/images/product_wireless_keyboard_1795284933913.jpg',
  '/src/assets/images/product_smartwatch_titanium_1795284934484.jpg',
  '/src/assets/images/product_studio_headphones_1795284934780.jpg',
];

export async function runSeed(): Promise<void> {
  if (!isPgConfigured()) {
    throw new Error('PG_URI is not set. Configure Aiven PostgreSQL before running seed.');
  }

  const pool = getPool();

  // Clear existing data safely for repeatable seeding
  await pool.query(`
    TRUNCATE TABLE
      coupon_redemptions, coupon_customer_usage, coupons,
      alert_subscriptions, recently_viewed, user_wishlist, customer_addresses,
      notifications, shipment_timeline, stock_transfers, refunds, after_sales_cases,
      payments, order_items, fulfilment_groups, orders, cart_items, carts,
      reservations, offer_price_history, offer_state_versions, processed_events,
      outbox_events, inventory, hub_service_areas, fulfilment_hubs,
      stock_locations, dealer_offers, dealers, products, categories, users
    RESTART IDENTITY CASCADE
  `);

  // 1. Demo accounts (customer + admin)
  const customerPass = 'Demo@1234';
  const adminPass = env.seedAdminPassword || 'Admin@1234';
  const customerHash = await bcrypt.hash(customerPass, 10);
  const adminHash = await bcrypt.hash(adminPass, 10);

  const userRes = await pool.query<{ user_id: string; email: string }>(
    `INSERT INTO users (name, email, password_hash, role) VALUES
       ('Aarav Sharma (Demo Customer)', 'demo@bazaarbridge.dev', $1, 'customer'),
       ('Priya Nair (Second Customer)', 'demo2@bazaarbridge.dev', $1, 'customer'),
       ('BazaarBridge Operations Admin', 'admin@bazaarbridge.dev', $2, 'admin')
     RETURNING user_id, email`,
    [customerHash, adminHash]
  );
  const demoUserId = userRes.rows.find((u) => u.email === 'demo@bazaarbridge.dev')!.user_id;

  // 2. Locations: Bangalore warehouse (is_home), Indiranagar Hub, Quarantine, Mysuru Holding
  const locRes = await pool.query<{ location_id: string; name: string }>(
    `INSERT INTO stock_locations (name, city, state, location_type, is_home, is_sellable) VALUES
       ('Bangalore Central Warehouse', 'Bangalore', 'Karnataka', 'warehouse', true, true),
       ('Indiranagar Quick Hub', 'Bangalore', 'Karnataka', 'hub', false, true),
       ('Peenya Quarantine Bay', 'Bangalore', 'Karnataka', 'quarantine', false, false),
       ('Mysuru Regional Holding', 'Mysuru', 'Karnataka', 'holding', false, true)
     RETURNING location_id, name`
  );
  const whBlrId = locRes.rows.find((l) => l.name === 'Bangalore Central Warehouse')!.location_id;
  const hubBlrId = locRes.rows.find((l) => l.name === 'Indiranagar Quick Hub')!.location_id;
  const quarantineId = locRes.rows.find((l) => l.name === 'Peenya Quarantine Bay')!.location_id;
  const mysuruLocId = locRes.rows.find((l) => l.name === 'Mysuru Regional Holding')!.location_id;

  const hubInsert = await pool.query<{ hub_id: string }>(
    `INSERT INTO fulfilment_hubs (location_id, address, hours, active, order_capacity, delivery_radius_km)
     VALUES ($1, '100 Feet Rd, Indiranagar, Bangalore 560038', '{"open":"00:00","close":"23:59"}'::jsonb, true, 20, 6.5)
     RETURNING hub_id`,
    [hubBlrId]
  );
  const hubId = hubInsert.rows[0].hub_id;

  await pool.query(
    `INSERT INTO hub_service_areas (hub_id, pin_code) VALUES
       ($1, '560038'),
       ($1, '560008'),
       ($1, '560001')`,
    [hubId]
  );

  // 3. 5 Categories
  const catNames = [
    'Audio & Speakers',
    'Keyboards & Input',
    'Wearables',
    'Accessories',
    'Smart Home',
  ];
  const catRes = await pool.query<{ category_id: string; category_name: string }>(
    `INSERT INTO categories (category_name)
     SELECT unnest($1::text[])
     RETURNING category_id, category_name`,
    [catNames]
  );
  const catMap = new Map(catRes.rows.map((c) => [c.category_name, c.category_id]));

  // 4. 5 Bangalore dealers + 1 Mysuru dealer
  const dealersRes = await pool.query<{ dealer_id: string; shop_name: string }>(
    `INSERT INTO dealers (shop_name, city, state, contact, dealer_rating, total_reviews, verified, supplier_status) VALUES
       ('Budget Audio Hub', 'Bangalore', 'Karnataka', '+91-80-4000-0001', 3.9, 12, true, 'active'),
       ('Express Electro', 'Bangalore', 'Karnataka', '+91-80-4000-0002', 4.3, 6, true, 'active'),
       ('Premier Acoustics', 'Bangalore', 'Karnataka', '+91-80-4000-0003', 4.8, 3, true, 'active'),
       ('Koramangala Tech Mart', 'Bangalore', 'Karnataka', '+91-80-4000-0004', 4.4, 9, true, 'active'),
       ('Metro Depot Electronics', 'Bangalore', 'Karnataka', '+91-80-4000-0005', 4.1, 40, true, 'active'),
       ('Chamundi Digital Traders', 'Mysuru', 'Karnataka', '+91-821-240-0006', 4.5, 24, true, 'active')
     RETURNING dealer_id, shop_name`
  );
  const d1 = dealersRes.rows[0].dealer_id;
  const d2 = dealersRes.rows[1].dealer_id;
  const d3 = dealersRes.rows[2].dealer_id;
  const d4 = dealersRes.rows[3].dealer_id;
  const d5 = dealersRes.rows[4].dealer_id;
  const dMysuru = dealersRes.rows[5].dealer_id;

  // 5. 40 products across the 5 categories
  const productSpecs: Array<{
    name: string;
    brand: string;
    category: string;
    description: string;
    image: string;
    specs: Record<string, string>;
  }> = [
    {
      name: 'SoundCraft Pulse Bluetooth Speaker',
      brand: 'SoundCraft',
      category: 'Audio & Speakers',
      description: 'Portable 20W IPX7 Bluetooth 5.3 speaker with anodized brass control ring and 18-hour playback (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[0],
      specs: { connectivity: 'Bluetooth 5.3', output: '20W RMS', battery: '18 hours', rating: 'IPX7' },
    },
    {
      name: 'KeyForge Pro 75 Wireless Mechanical Keyboard',
      brand: 'KeyForge',
      category: 'Keyboards & Input',
      description: 'CNC aluminum gasket-mounted 75% wireless mechanical keyboard with rotary encoder (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[1],
      specs: { connectivity: 'Tri-mode 2.4GHz / BT 5.2 / USB-C', switches: 'Tactile Linear', chassis: 'Anodized Aluminum' },
    },
    {
      name: 'Chronos Titanium Smart Watch Series 4',
      brand: 'Chronos',
      category: 'Wearables',
      description: 'Grade-5 brushed titanium smartwatch with dual-frequency GPS and woven nylon band (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[2],
      specs: { case: '44mm Titanium', battery: '7 days', display: 'AMOLED 1.85"', resistance: '5 ATM' },
    },
    {
      name: 'Alabaster Studio Wireless ANC Headphones',
      brand: 'Alabaster Audio',
      category: 'Audio & Speakers',
      description: 'Over-ear hybrid active noise-cancelling studio headphones with multipoint Bluetooth (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[3],
      specs: { connectivity: 'Bluetooth 5.3 + 3.5mm', driver: '40mm Beryllium', battery: '45 hours ANC' },
    },
    {
      name: 'Chamundi Bluetooth Earphones Lite',
      brand: 'Chamundi Audio',
      category: 'Audio & Speakers',
      description: 'Lightweight neckband Bluetooth earphones stocked by Mysuru and Bangalore dealers (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[3],
      specs: { connectivity: 'Bluetooth 5.3', playback: '24 hours', charging: 'USB-C Fast' },
    },
    {
      name: 'AeroPods Limited Edition 1-Unit Drop',
      brand: 'AeroAudio',
      category: 'Audio & Speakers',
      description: 'Single-unit limited batch audio receiver used to demonstrate atomic last-unit reservation (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[0],
      specs: { connectivity: 'Bluetooth 5.3', batch: 'Single Unit Test' },
    },
    {
      name: 'Mysuru Heritage Soundbar Transfer Edition',
      brand: 'Deccan Acoustics',
      category: 'Audio & Speakers',
      description: 'Compact desktop soundbar stocked exclusively in Mysuru Regional Holding for Section B transfer workflow (SAMPLE catalog item).',
      image: PRODUCT_IMAGES[0],
      specs: { connectivity: 'Bluetooth + Optical', output: '40W', origin: 'Mysuru' },
    },
  ];

  // Fill remaining 33 products up to 40 across all 5 categories
  const extraBases = [
    ['Audio & Speakers', 'AcousticLab', ['Studio Monitor Pair', 'Pocket Bluetooth Mini', 'Hi-Fi DAC Amp', 'Conference Speakerphone', 'BoomBass Outdoor', 'Vinyl Phono Preamp'], PRODUCT_IMAGES[0]],
    ['Keyboards & Input', 'TypeCraft', ['Silent Ergonomic Mouse', 'Low-Profile TKL Keyboard', 'Precision Trackball', 'Numpad Macro Deck', 'Split Ergo Keyboard', 'Creator Dial Pad', 'Desk Mat Wool'], PRODUCT_IMAGES[1]],
    ['Wearables', 'PulseFit', ['Sport Band Pro', 'Minimalist Hybrid Watch', 'Sleep Ring Titanium', 'Trail GPS Watch', 'Kids Safety Band', 'Runner HR Strap', 'Chrono Charger Dock'], PRODUCT_IMAGES[2]],
    ['Accessories', 'VoltBridge', ['GaN 100W Charger', 'Braided USB-C 240W Cable', 'MagSafe Travel Stand', 'Thunderbolt 4 Hub', 'Aluminum Laptop Riser', 'NVMe Enclosure Pro', 'Webcam Privacy Cover'], PRODUCT_IMAGES[1]],
    ['Smart Home', 'NammaHome', ['Matter Smart Plug', 'Air Quality Sensor', 'Mesh Wi-Fi 6E Node', 'Smart Desk Lamp', 'Video Doorbell Lite', 'Temperature Hub'], PRODUCT_IMAGES[2]],
  ] as const;

  for (const [category, brand, names, img] of extraBases) {
    for (const itemName of names) {
      if (productSpecs.length >= 40) break;
      productSpecs.push({
        name: `${brand} ${itemName}`,
        brand,
        category,
        description: `Local dealer-verified ${itemName.toLowerCase()} with transparent delivery options across Bangalore (SAMPLE catalog item).`,
        image: img,
        specs: { warranty: '12 Months', grade: 'Retail Sealed', category },
      });
    }
  }

  const insertedProducts: Array<{ product_id: string; name: string }> = [];
  for (const p of productSpecs) {
    const res = await pool.query<{ product_id: string; name: string }>(
      `INSERT INTO products (name, description, brand, category_id, specs, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING product_id, name`,
      [p.name, p.description, p.brand, catMap.get(p.category)!, JSON.stringify(p.specs), p.image]
    );
    insertedProducts.push(res.rows[0]);
  }

  const speakerProd = insertedProducts[0]; // SoundCraft Pulse Bluetooth Speaker
  const mixedCartProd = insertedProducts[1]; // KeyForge Pro 75 Wireless Mechanical Keyboard
  const earphonesProd = insertedProducts[4]; // Chamundi Bluetooth Earphones Lite
  const singleUnitProd = insertedProducts[5]; // AeroPods Limited Edition 1-Unit Drop
  const transferOnlyProd = insertedProducts[6]; // Mysuru Heritage Soundbar Transfer Edition

  // 6. Five comparison offers on Bluetooth Speaker (all stocked in Bangalore warehouse)
  // Winners: Budget Rs.699, Fastest Rs.779, Rated Rs.749, Value Rs.725, Most Available Rs.769
  const speakerOffers = [
    { dealer: d1, price: 69900, days: 4, units: 12 }, // Budget
    { dealer: d2, price: 77900, days: 1, units: 10 }, // Fastest
    { dealer: d3, price: 74900, days: 2, units: 14 }, // Best Rated (4.8)
    { dealer: d4, price: 72500, days: 2, units: 18 }, // Best Value
    { dealer: d5, price: 76900, days: 3, units: 40 }, // Most Available (40 units)
  ];

  const allOfferIds: string[] = [];
  const speakerOfferIds: string[] = [];

  for (const so of speakerOffers) {
    const oRes = await pool.query<{ offer_id: string }>(
      `INSERT INTO dealer_offers (
         product_id, dealer_id, purchase_price, selling_price, status,
         bangalore_delivery_days, eligible_modes, warranty_months, warranty_note
       ) VALUES ($1, $2, $3, $4, 'active', $5, '{standard}', 12, '12 months dealer warranty (SAMPLE)')
       RETURNING offer_id`,
      [speakerProd.product_id, so.dealer, so.price - 10000, so.price, so.days]
    );
    const offerId = oRes.rows[0].offer_id;
    allOfferIds.push(offerId);
    speakerOfferIds.push(offerId);

    await pool.query(
      `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, 0)`,
      [offerId, whBlrId, so.units]
    );
  }

  // Add closed SAMPLE price history rows AFTER offer inserts (v7.2 trigger safety)
  for (const offerId of speakerOfferIds) {
    await pool.query(
      `INSERT INTO offer_price_history (offer_id, selling_price, valid_from, valid_to)
       VALUES ($1, 89900, now() - interval '20 days', now() - interval '1 day')`,
      [offerId]
    );
  }

  // 7. Mixed-cart demo product: stocked at BOTH Indiranagar Hub (quick eligible) AND Bangalore warehouse
  const mixedHubOfferRes = await pool.query<{ offer_id: string }>(
    `INSERT INTO dealer_offers (
       product_id, dealer_id, purchase_price, selling_price, status,
       bangalore_delivery_days, eligible_modes, warranty_months, warranty_note
     ) VALUES ($1, $2, 320000, 399900, 'active', 1, '{quick,standard}', 12, '12 months warranty (SAMPLE)')
     RETURNING offer_id`,
    [mixedCartProd.product_id, d4]
  );
  const mixedHubOfferId = mixedHubOfferRes.rows[0].offer_id;
  allOfferIds.push(mixedHubOfferId);

  await pool.query(
    `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity) VALUES
       ($1, $2, 15, 0),
       ($1, $3, 25, 0)`,
    [mixedHubOfferId, hubBlrId, whBlrId]
  );

  // 8. 1-unit concurrency test product
  const singleOfferRes = await pool.query<{ offer_id: string }>(
    `INSERT INTO dealer_offers (
       product_id, dealer_id, purchase_price, selling_price, status,
       bangalore_delivery_days, eligible_modes, warranty_months, warranty_note
     ) VALUES ($1, $2, 100000, 129900, 'active', 2, '{standard}', 12, 'Limited drop (SAMPLE)')
     RETURNING offer_id`,
    [singleUnitProd.product_id, d2]
  );
  allOfferIds.push(singleOfferRes.rows[0].offer_id);
  await pool.query(
    `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity)
     VALUES ($1, $2, 1, 0)`,
    [singleOfferRes.rows[0].offer_id, whBlrId]
  );

  // 9. Section B transfer-only offer: stocked ONLY at Mysuru with NO Bangalore row
  const transferOfferRes = await pool.query<{ offer_id: string }>(
    `INSERT INTO dealer_offers (
       product_id, dealer_id, purchase_price, selling_price, status,
       transfer_days_min, transfer_days_max, eligible_modes, warranty_months, warranty_note
     ) VALUES ($1, $2, 180000, 249900, 'active', 2, 3, '{transfer}', 12, 'Inter-city transfer (SAMPLE)')
     RETURNING offer_id`,
    [transferOnlyProd.product_id, dMysuru]
  );
  allOfferIds.push(transferOfferRes.rows[0].offer_id);
  await pool.query(
    `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity)
     VALUES ($1, $2, 12, 0)`,
    [transferOfferRes.rows[0].offer_id, mysuruLocId]
  );

  // 10. Mysuru dealer selling Bluetooth earphones in BOTH Mysuru stock AND Bangalore warehouse
  const mysuruEarphoneOffer = await pool.query<{ offer_id: string }>(
    `INSERT INTO dealer_offers (
       product_id, dealer_id, purchase_price, selling_price, status,
       bangalore_delivery_days, transfer_days_min, transfer_days_max, eligible_modes, warranty_months
     ) VALUES ($1, $2, 80000, 119900, 'active', 2, 2, 3, '{standard,transfer}', 12)
     RETURNING offer_id`,
    [earphonesProd.product_id, dMysuru]
  );
  allOfferIds.push(mysuruEarphoneOffer.rows[0].offer_id);
  await pool.query(
    `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity) VALUES
       ($1, $2, 14, 0),
       ($1, $3, 18, 0)`,
    [mysuruEarphoneOffer.rows[0].offer_id, whBlrId, mysuruLocId]
  );

  // 11. Offers for all remaining products (2-3 offers each, plus quarantine sample row on one)
  const dealerPool = [d1, d2, d3, d4, d5];
  for (let i = 0; i < insertedProducts.length; i += 1) {
    if ([0, 1, 4, 5, 6].includes(i)) continue;
    const prod = insertedProducts[i];
    const basePrice = 89900 + (i % 10) * 35000;
    const numOffers = i < 15 ? 3 : 2;

    for (let j = 0; j < numOffers; j += 1) {
      const dealerId = dealerPool[(i + j) % dealerPool.length];
      const sellingPrice = basePrice + j * 15000;
      const isQuickCapable = j === 0 && i % 2 === 0;
      const offerRes = await pool.query<{ offer_id: string }>(
        `INSERT INTO dealer_offers (
           product_id, dealer_id, purchase_price, selling_price, status,
           bangalore_delivery_days, eligible_modes, warranty_months, warranty_note
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 12, 'Dealer warranty (SAMPLE)')
         RETURNING offer_id`,
        [
          prod.product_id,
          dealerId,
          Math.floor(sellingPrice * 0.8),
          sellingPrice,
          j + 1,
          isQuickCapable ? ['quick', 'standard'] : ['standard'],
        ]
      );
      const oid = offerRes.rows[0].offer_id;
      allOfferIds.push(oid);

      await pool.query(
        `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity)
         VALUES ($1, $2, $3, 0)`,
        [oid, isQuickCapable ? hubBlrId : whBlrId, 10 + ((i + j) % 15)]
      );

      if (i === 2 && j === 0) {
        // Seed quarantine stock on Smartwatch to verify non-sellable exclusion
        await pool.query(
          `INSERT INTO inventory (offer_id, location_id, quantity, reserved_quantity)
           VALUES ($1, $2, 20, 0)`,
          [oid, quarantineId]
        );
      }
    }
  }

  // 12. Sample address & coupons for OPTIONAL Phase 2 features
  await pool.query(
    `INSERT INTO customer_addresses (
       user_id, label, recipient_name, phone, line1, line2, city, state, pin_code, is_default
     ) VALUES (
       $1, 'Home', 'Aarav Sharma', '+91-98450-00001', '42 12th Main Rd, HAL 2nd Stage', 'Indiranagar', 'Bangalore', 'Karnataka', '560038', true
     )`,
    [demoUserId]
  );

  await pool.query(
    `INSERT INTO coupons (code, kind, value, min_basket_paise, max_redemptions, per_customer_limit, valid_from, valid_to, active) VALUES
       ('SINGLEUSE1', 'fixed_paise', 5000, 50000, 1, 1, now() - interval '1 day', now() + interval '30 days', true),
       ('PERUSER1', 'fixed_paise', 5000, 50000, 100, 1, now() - interval '1 day', now() + interval '30 days', true),
       ('WELCOME100', 'fixed_paise', 10000, 99900, 500, 3, now() - interval '1 day', now() + interval '30 days', true)`
  );

  // 13. Index active offers into OpenSearch if configured
  if (isOpenSearchConfigured()) {
    await ensureIndex();
    for (const offerId of allOfferIds) {
      await upsertOffer(offerId);
    }
    console.log(`Indexed ${allOfferIds.length} offers into Aiven OpenSearch.`);
  } else {
    console.log('OPENSEARCH_URL not set; skipped OpenSearch indexing during seed.');
  }

  console.log(`BazaarBridge seed completed: ${insertedProducts.length} products, ${allOfferIds.length} offers.`);
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  runSeed()
    .then(() => closePool())
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await closePool();
      process.exit(1);
    });
}
