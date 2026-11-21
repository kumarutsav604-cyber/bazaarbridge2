import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOffersByCategory, type EligibleOfferRow } from '../../domain/comparison.ts';

const seedSpeakerOffers: EligibleOfferRow[] = [
  {
    offer_id: 'offer-699',
    product_id: 'prod-speaker',
    product_name: 'SoundCraft Pulse Bluetooth Speaker',
    dealer_id: 'd1',
    shop_name: 'Budget Audio Hub',
    dealer_city: 'Bangalore',
    dealer_rating: 3.9,
    total_reviews: 12,
    verified: true,
    selling_price: 69900,
    status: 'active',
    bangalore_delivery_days: 4,
    transfer_days_min: null,
    transfer_days_max: null,
    warranty_months: 12,
    warranty_note: '1 year brand warranty',
    eligible_modes: ['standard'],
    sellable_free_units: 12,
    home_units: 12,
    preferred_location_id: 'wh-blr',
    preferred_location_name: 'Bangalore Warehouse',
  },
  {
    offer_id: 'offer-779',
    product_id: 'prod-speaker',
    product_name: 'SoundCraft Pulse Bluetooth Speaker',
    dealer_id: 'd2',
    shop_name: 'Express Electro',
    dealer_city: 'Bangalore',
    dealer_rating: 4.3,
    total_reviews: 6,
    verified: true,
    selling_price: 77900,
    status: 'active',
    bangalore_delivery_days: 1,
    transfer_days_min: null,
    transfer_days_max: null,
    warranty_months: 12,
    warranty_note: '1 year brand warranty',
    eligible_modes: ['standard'],
    sellable_free_units: 10,
    home_units: 10,
    preferred_location_id: 'wh-blr',
    preferred_location_name: 'Bangalore Warehouse',
  },
  {
    offer_id: 'offer-749',
    product_id: 'prod-speaker',
    product_name: 'SoundCraft Pulse Bluetooth Speaker',
    dealer_id: 'd3',
    shop_name: 'Premier Acoustics',
    dealer_city: 'Bangalore',
    dealer_rating: 4.8,
    total_reviews: 3,
    verified: true,
    selling_price: 74900,
    status: 'active',
    bangalore_delivery_days: 2,
    transfer_days_min: null,
    transfer_days_max: null,
    warranty_months: 24,
    warranty_note: '2 year extended warranty',
    eligible_modes: ['standard'],
    sellable_free_units: 14,
    home_units: 14,
    preferred_location_id: 'wh-blr',
    preferred_location_name: 'Bangalore Warehouse',
  },
  {
    offer_id: 'offer-725',
    product_id: 'prod-speaker',
    product_name: 'SoundCraft Pulse Bluetooth Speaker',
    dealer_id: 'd4',
    shop_name: 'Koramangala Tech Mart',
    dealer_city: 'Bangalore',
    dealer_rating: 4.4,
    total_reviews: 9,
    verified: true,
    selling_price: 72500,
    status: 'active',
    bangalore_delivery_days: 2,
    transfer_days_min: null,
    transfer_days_max: null,
    warranty_months: 12,
    warranty_note: '1 year brand warranty',
    eligible_modes: ['standard'],
    sellable_free_units: 18,
    home_units: 18,
    preferred_location_id: 'wh-blr',
    preferred_location_name: 'Bangalore Warehouse',
  },
  {
    offer_id: 'offer-769',
    product_id: 'prod-speaker',
    product_name: 'SoundCraft Pulse Bluetooth Speaker',
    dealer_id: 'd5',
    shop_name: 'Metro Depot Electronics',
    dealer_city: 'Bangalore',
    dealer_rating: 4.1,
    total_reviews: 40,
    verified: true,
    selling_price: 76900,
    status: 'active',
    bangalore_delivery_days: 3,
    transfer_days_min: null,
    transfer_days_max: null,
    warranty_months: 12,
    warranty_note: '1 year brand warranty',
    eligible_modes: ['standard'],
    sellable_free_units: 40,
    home_units: 40,
    preferred_location_id: 'wh-blr',
    preferred_location_name: 'Bangalore Warehouse',
  },
];

test('v7.2 seed speaker comparison selects 5 distinct winning offers', () => {
  const budget = rankOffersByCategory(seedSpeakerOffers, 'budget');
  const fastest = rankOffersByCategory(seedSpeakerOffers, 'fastest');
  const rated = rankOffersByCategory(seedSpeakerOffers, 'rated');
  const value = rankOffersByCategory(seedSpeakerOffers, 'value');
  const available = rankOffersByCategory(seedSpeakerOffers, 'available');

  assert.equal(budget?.winner.selling_price, 69900);
  assert.equal(fastest?.winner.selling_price, 77900);
  assert.equal(rated?.winner.selling_price, 74900);
  assert.equal(value?.winner.selling_price, 72500);
  assert.equal(available?.winner.selling_price, 76900);

  const uniqueWinners = new Set([
    budget?.winner.offer_id,
    fastest?.winner.offer_id,
    rated?.winner.offer_id,
    value?.winner.offer_id,
    available?.winner.offer_id,
  ]);
  assert.equal(uniqueWinners.size, 5);

  assert.ok(budget?.winner.reason.includes('Rs.699'));
  assert.ok(available?.winner.reason.includes('40 free units'));
});
