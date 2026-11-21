import { Bell, LogOut, Menu, ShoppingBag, User, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useSystem } from '../context/SystemContext';
import { apiFetch, usePolling } from '../kit';

interface NotificationRow {
  notification_id: string;
  message: string;
  event_ref: string | null;
  created_at: string;
  read_at: string | null;
}

export function Navbar() {
  const { user, logout } = useAuth();
  const { items } = useCart();
  const { isFeatureEnabled } = useSystem();
  const navigate = useNavigate();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);

  const fetchNotifications = useCallback(async () => {
    if (!user) {
      setNotifications([]);
      return;
    }
    try {
      const res = await apiFetch<{ notifications: NotificationRow[] }>('/api/notifications');
      setNotifications(res.notifications || []);
    } catch {
      // ignore background polling failures
    }
  }, [user]);

  usePolling(fetchNotifications, 8000, Boolean(user));

  const unreadCount = notifications.filter((n) => !n.read_at).length;
  const cartCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const handleMarkRead = async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
      setNotifications((prev) =>
        prev.map((n) => (n.notification_id === id ? { ...n, read_at: new Date().toISOString() } : n))
      );
    } catch {
      // ignore
    }
  };

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `whitespace-nowrap shrink-0 text-sm font-medium transition-colors ${
      isActive ? 'text-[#4F46E5]' : 'text-[#64748B] hover:text-[#111827]'
    }`;

  return (
    <header className="sticky top-0 z-40 border-b border-[#E2E8F0] bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Brand wordmark only */}
        <Link
          to="/"
          className="shrink-0 whitespace-nowrap font-display text-xl font-bold tracking-tight text-[#111827]"
        >
          BazaarBridge
        </Link>

        {/* Zone 2: Concise single-line nav links */}
        <nav aria-label="Primary navigation" className="hidden items-center gap-6 md:flex">
          <NavLink to="/" end className={navLinkClass}>
            Storefront
          </NavLink>
          <NavLink to="/products" className={navLinkClass}>
            Catalog
          </NavLink>
          <NavLink to="/compare" className={navLinkClass}>
            Compare Deals
          </NavLink>
          <NavLink to="/outside-bangalore" className={navLinkClass}>
            Outside Bangalore
          </NavLink>
          {user?.role === 'admin' ? (
            <NavLink to="/admin" className={navLinkClass}>
              Simulator
            </NavLink>
          ) : (
            <NavLink to="/orders" className={navLinkClass}>
              Orders
            </NavLink>
          )}
        </nav>

        {/* Zone 3: Primary action + user/cart affordances */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {user && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  const next = !notifOpen;
                  setNotifOpen(next);
                  if (next) void fetchNotifications();
                }}
                aria-label="Notifications"
                className="relative flex h-10 w-10 items-center justify-center rounded-lg text-[#64748B] transition-colors hover:bg-slate-100 hover:text-[#111827]"
              >
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#4F46E5] px-1 font-mono text-[10px] font-semibold text-white tabular-nums">
                    {unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 rounded-xl border border-[#E2E8F0] bg-white p-3 shadow-lg">
                  <div className="mb-2 flex items-center justify-between border-b border-[#E2E8F0] pb-2">
                    <span className="text-xs font-semibold text-[#111827]">Notifications</span>
                    <button
                      type="button"
                      onClick={() => setNotifOpen(false)}
                      aria-label="Close notifications"
                      className="text-slate-400 hover:text-slate-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {notifications.length === 0 ? (
                    <p className="py-4 text-center text-xs text-[#64748B]">
                      No notifications yet. Order and fulfilment events appear here.
                    </p>
                  ) : (
                    <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
                      {notifications.slice(0, 12).map((n) => (
                        <li key={n.notification_id} className="py-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <p
                              className={`text-xs leading-snug ${
                                n.read_at ? 'text-[#64748B]' : 'font-medium text-[#111827]'
                              }`}
                            >
                              {n.message}
                            </p>
                            {!n.read_at && (
                              <button
                                type="button"
                                onClick={() => void handleMarkRead(n.notification_id)}
                                className="shrink-0 text-[11px] font-medium text-[#4F46E5] hover:underline"
                              >
                                Read
                              </button>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[10px] text-slate-400">
                            {new Date(n.created_at).toLocaleTimeString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <Link
            to="/cart"
            aria-label={`Shopping cart with ${cartCount} items`}
            className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm font-medium text-[#111827] transition-colors hover:bg-slate-50"
          >
            <ShoppingBag className="h-4 w-4 text-[#4F46E5]" />
            <span className="hidden sm:inline">Cart</span>
            <span className="font-mono text-xs font-semibold text-[#4F46E5] tabular-nums">
              {cartCount}
            </span>
          </Link>

          {user ? (
            <div className="hidden items-center gap-2 sm:flex">
              <span className="max-w-[140px] truncate text-xs font-medium text-[#64748B]">
                {user.role === 'admin' ? 'Admin' : 'Demo user'}: {user.name.split(' ')[0]}
              </span>
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate('/');
                }}
                aria-label="Sign out"
                className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-[#64748B] hover:bg-slate-100 hover:text-[#111827]"
              >
                <LogOut className="h-4 w-4" />
                <span>Sign out</span>
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#4F46E5] px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
            >
              <User className="h-4 w-4" />
              <span>Sign in</span>
            </Link>
          )}

          <button
            type="button"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileOpen}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-[#111827] hover:bg-slate-100 md:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="border-t border-[#E2E8F0] bg-white px-4 py-4 md:hidden">
          <nav className="flex flex-col gap-1">
            <Link
              to="/"
              onClick={() => setMobileOpen(false)}
              className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#111827] hover:bg-slate-50"
            >
              Storefront
            </Link>
            <Link
              to="/products"
              onClick={() => setMobileOpen(false)}
              className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#111827] hover:bg-slate-50"
            >
              Catalog & Search
            </Link>
            <Link
              to="/compare"
              onClick={() => setMobileOpen(false)}
              className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#111827] hover:bg-slate-50"
            >
              Compare Deals
            </Link>
            <Link
              to="/outside-bangalore"
              onClick={() => setMobileOpen(false)}
              className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#111827] hover:bg-slate-50"
            >
              Outside Bangalore
            </Link>
            <Link
              to="/orders"
              onClick={() => setMobileOpen(false)}
              className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#111827] hover:bg-slate-50"
            >
              My Orders
            </Link>
            {isFeatureEnabled('FEATURE_WISHLIST') && (
              <Link
                to="/wishlist"
                onClick={() => setMobileOpen(false)}
                className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#111827] hover:bg-slate-50"
              >
                Wishlist
              </Link>
            )}
            <Link
              to={user?.role === 'admin' ? '/admin' : '/admin-login'}
              onClick={() => setMobileOpen(false)}
              className="flex h-11 items-center rounded-lg px-3 text-sm font-medium text-[#4F46E5] hover:bg-slate-50"
            >
              {user?.role === 'admin' ? 'Admin Simulator' : 'Admin Login'}
            </Link>
            {user && (
              <button
                type="button"
                onClick={() => {
                  logout();
                  setMobileOpen(false);
                  navigate('/');
                }}
                className="mt-2 flex h-11 items-center rounded-lg px-3 text-left text-sm font-medium text-[#DC2626] hover:bg-red-50"
              >
                Sign out ({user.name})
              </button>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
