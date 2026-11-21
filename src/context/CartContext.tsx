import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch } from '../kit';
import { useAuth } from './AuthContext';

export interface CartItemRow {
  cart_item_id: string;
  offer_id: string;
  quantity: number;
  price_snapshot: number;
  current_price_paise: number;
  price_changed: boolean;
  reservation_id: string | null;
  reservation_status: string | null;
  reservation_expires_at: string | null;
  reservation_price_paise: number | null;
  reservation_location_id: string | null;
  preferred_location_id: string | null;
  product_id: string;
  product_name: string;
  brand: string;
  image_url: string | null;
  shop_name: string;
  dealer_city: string;
  available_units: number;
  eligible_modes: string[];
  bangalore_delivery_days: number | null;
  transfer_days_max: number | null;
}

interface CartContextValue {
  items: CartItemRow[];
  savedItems: CartItemRow[];
  subtotalPaise: number;
  loading: boolean;
  error: string | null;
  refreshCart: () => Promise<void>;
  addToCart: (offerId: string, quantity?: number) => Promise<void>;
  removeCartItem: (cartItemId: string) => Promise<void>;
}

const CartContext = createContext<CartContextValue>({
  items: [],
  savedItems: [],
  subtotalPaise: 0,
  loading: false,
  error: null,
  refreshCart: async () => {},
  addToCart: async () => {},
  removeCartItem: async () => {},
});

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [items, setItems] = useState<CartItemRow[]>([]);
  const [savedItems, setSavedItems] = useState<CartItemRow[]>([]);
  const [subtotalPaise, setSubtotalPaise] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCart = useCallback(async () => {
    if (!user) {
      setItems([]);
      setSavedItems([]);
      setSubtotalPaise(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{
        items: CartItemRow[];
        saved_items: CartItemRow[];
        subtotal_paise: number;
      }>('/api/cart');
      setItems(res.items || []);
      setSavedItems(res.saved_items || []);
      setSubtotalPaise(res.subtotal_paise || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load cart.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refreshCart();
  }, [refreshCart]);

  const addToCart = useCallback(
    async (offerId: string, quantity = 1) => {
      await apiFetch('/api/cart/items', {
        method: 'POST',
        body: JSON.stringify({ offer_id: offerId, quantity }),
      });
      await refreshCart();
    },
    [refreshCart]
  );

  const removeCartItem = useCallback(
    async (cartItemId: string) => {
      await apiFetch(`/api/cart/items/${cartItemId}`, {
        method: 'DELETE',
      });
      await refreshCart();
    },
    [refreshCart]
  );

  return (
    <CartContext.Provider
      value={{
        items,
        savedItems,
        subtotalPaise,
        loading,
        error,
        refreshCart,
        addToCart,
        removeCartItem,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  return useContext(CartContext);
}
