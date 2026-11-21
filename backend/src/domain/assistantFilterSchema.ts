import { z } from 'zod';

export const AssistantFiltersSchema = z
  .object({
    category: z.string().min(1).max(80).optional(),
    product_type: z.string().min(1).max(80).optional(),
    connectivity: z.string().min(1).max(60).optional(),
    features: z.array(z.string().min(1).max(60)).max(6).optional(),
    max_price: z.number().int().positive().max(100_000_000).optional(), // paise
    max_delivery_days: z.number().int().min(1).max(30).optional(),
    city: z.string().min(1).max(80).optional(),
    delivery_mode: z.enum(['quick', 'standard']).optional(),
    sort_preference: z.enum(['budget', 'fastest', 'rated', 'value', 'available']).optional(),
  })
  .strict();

export type AssistantFilters = z.infer<typeof AssistantFiltersSchema>;

export function extractRuleBasedFilters(message: string): AssistantFilters {
  const lower = message.toLowerCase();
  const filters: AssistantFilters = {};

  if (lower.includes('speaker') || lower.includes('audio') || lower.includes('headphone') || lower.includes('earphone')) {
    filters.category = 'Audio & Speakers';
  } else if (lower.includes('keyboard') || lower.includes('mouse')) {
    filters.category = 'Keyboards & Input';
  } else if (lower.includes('watch') || lower.includes('wearable')) {
    filters.category = 'Wearables';
  }

  if (lower.includes('bluetooth') || lower.includes('bluetoth') || lower.includes('wireless')) {
    filters.connectivity = 'bluetooth';
    filters.product_type = lower.includes('headphone')
      ? 'headphones'
      : lower.includes('earphone')
        ? 'earphones'
        : lower.includes('keyboard')
          ? 'keyboard'
          : 'speaker';
  }

  const priceMatch = lower.match(/(?:under|below|max|less than|<=?)\s*(?:rs\.?|₹)?\s*(\d{2,6})/);
  if (priceMatch) {
    const rupees = parseInt(priceMatch[1], 10);
    if (rupees > 0 && rupees <= 1000000) {
      filters.max_price = rupees * 100; // integer paise
    }
  }

  if (lower.includes('mysuru') || lower.includes('mysore')) {
    filters.city = 'Mysuru';
  } else if (lower.includes('bangalore') || lower.includes('bengaluru')) {
    filters.city = 'Bangalore';
  }

  if (lower.includes('quick')) {
    filters.delivery_mode = 'quick';
    filters.sort_preference = 'fastest';
  } else if (lower.includes('cheap') || lower.includes('budget')) {
    filters.sort_preference = 'budget';
  } else if (lower.includes('best rated') || lower.includes('top rated')) {
    filters.sort_preference = 'rated';
  }

  return filters;
}
