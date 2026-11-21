export type ComparisonCategory = 'budget' | 'fastest' | 'rated' | 'value' | 'available';

export interface EligibleOfferRow {
  offer_id: string;
  product_id: string;
  product_name: string;
  dealer_id: string;
  shop_name: string;
  dealer_city: string;
  dealer_rating: number;
  total_reviews: number;
  verified: boolean;
  selling_price: number; // bigint paise
  status: string;
  bangalore_delivery_days: number | null;
  transfer_days_min: number | null;
  transfer_days_max: number | null;
  warranty_months: number;
  warranty_note: string | null;
  eligible_modes: string[];
  sellable_free_units: number;
  home_units: number;
  preferred_location_id: string | null;
  preferred_location_name: string | null;
}

export interface RankedOfferResult {
  category: ComparisonCategory;
  winner: EligibleOfferRow & {
    effective_days: number;
    value_score: number;
    reason: string;
  };
  ranked: Array<
    EligibleOfferRow & {
      effective_days: number;
      value_score: number;
      reason: string;
    }
  >;
}

export function formatRupeesFromPaise(paise: number): string {
  const rupees = paise / 100;
  return Number.isInteger(rupees) ? `Rs.${rupees}` : `Rs.${rupees.toFixed(2)}`;
}

export function computeEffectiveDays(offer: Pick<EligibleOfferRow, 'home_units' | 'bangalore_delivery_days' | 'transfer_days_max'>): number {
  if (offer.home_units > 0 && offer.bangalore_delivery_days !== null) {
    return offer.bangalore_delivery_days;
  }
  if (offer.transfer_days_max !== null) {
    return offer.transfer_days_max;
  }
  return offer.bangalore_delivery_days ?? 3;
}

export function computeBestValueScores(offers: EligibleOfferRow[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (offers.length === 0) return scores;

  const prices = offers.map((o) => o.selling_price);
  const days = offers.map((o) => computeEffectiveDays(o));

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minDays = Math.min(...days);
  const maxDays = Math.max(...days);

  for (let i = 0; i < offers.length; i += 1) {
    const o = offers[i];
    const d = days[i];

    const priceFactor =
      maxPrice === minPrice ? 100 : (100 * (maxPrice - o.selling_price)) / (maxPrice - minPrice);
    const deliveryFactor =
      maxDays === minDays ? 100 : (100 * (maxDays - d)) / (maxDays - minDays);
    const ratingFactor = (100 * Number(o.dealer_rating)) / 5;
    const stockFactor = o.sellable_free_units > 0 ? 100 : 0;

    const weighted =
      0.45 * priceFactor +
      0.25 * deliveryFactor +
      0.20 * ratingFactor +
      0.10 * stockFactor;

    scores.set(o.offer_id, Number(weighted.toFixed(2)));
  }

  return scores;
}

export function buildComparisonReason(
  category: ComparisonCategory,
  offer: EligibleOfferRow,
  effectiveDays: number,
  totalInStock: number,
  valueScore: number
): string {
  const priceStr = formatRupeesFromPaise(offer.selling_price);
  switch (category) {
    case 'budget':
      return `Lowest price ${priceStr} among ${totalInStock} in-stock offers - ${effectiveDays}-day delivery`;
    case 'fastest':
      return `Fastest ${effectiveDays}-day delivery at ${priceStr} from ${offer.shop_name}`;
    case 'rated':
      return `Highest dealer rating ${Number(offer.dealer_rating).toFixed(1)}/5 (${offer.total_reviews} reviews) at ${priceStr}`;
    case 'value':
      return `Best weighted value score (${valueScore.toFixed(1)}/100) balancing ${priceStr}, ${effectiveDays}-day delivery and ${Number(offer.dealer_rating).toFixed(1)} rating`;
    case 'available':
      return `Highest ready stock with ${offer.sellable_free_units} free units at ${priceStr}`;
  }
}

export function rankOffersByCategory(
  offers: EligibleOfferRow[],
  category: ComparisonCategory
): RankedOfferResult | null {
  const eligible = offers.filter((o) => o.status === 'active' && o.sellable_free_units > 0);
  if (eligible.length === 0) return null;

  const valueScores = computeBestValueScores(eligible);

  const enriched = eligible.map((o) => {
    const effective_days = computeEffectiveDays(o);
    const value_score = valueScores.get(o.offer_id) ?? 0;
    return {
      ...o,
      effective_days,
      value_score,
      reason: buildComparisonReason(category, o, effective_days, eligible.length, value_score),
    };
  });

  enriched.sort((a, b) => {
    switch (category) {
      case 'budget':
        return (
          a.selling_price - b.selling_price ||
          a.effective_days - b.effective_days ||
          Number(b.dealer_rating) - Number(a.dealer_rating)
        );
      case 'fastest':
        return a.effective_days - b.effective_days || a.selling_price - b.selling_price;
      case 'rated':
        return (
          Number(b.dealer_rating) - Number(a.dealer_rating) ||
          b.total_reviews - a.total_reviews ||
          a.selling_price - b.selling_price
        );
      case 'value':
        return b.value_score - a.value_score || a.selling_price - b.selling_price;
      case 'available':
        return b.sellable_free_units - a.sellable_free_units || a.selling_price - b.selling_price;
    }
  });

  return {
    category,
    winner: enriched[0],
    ranked: enriched,
  };
}
