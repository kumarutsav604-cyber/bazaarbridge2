import { ArrowRight, KeyRound, ShieldAlert, User } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export function LoginPage() {
  const { login, user } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo =
    (location.state as { from?: string } | null)?.from || '/products';

  // Customer demo account prefilled & clearly labelled SAMPLE
  const [email, setEmail] = useState('demo@bazaarbridge.dev');
  const [password, setPassword] = useState('Demo@1234');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performLogin = async (targetEmail: string, targetPassword: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const loggedIn = await login(targetEmail.trim(), targetPassword);
      addToast(`Signed in as ${loggedIn.name}.`, 'success');
      navigate(loggedIn.role === 'admin' ? '/admin' : redirectTo, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wider text-[#4F46E5] uppercase">
              Customer Access
            </p>
            <h1 className="mt-1 font-display text-2xl font-bold text-[#111827]">
              Sign in to BazaarBridge
            </h1>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-[#4F46E5]">
            <User className="h-5 w-5" />
          </div>
        </div>

        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-950">
          <p className="font-mono text-[10px] font-bold tracking-wider uppercase">
            SAMPLE DEMO ACCOUNT
          </p>
          <p className="mt-1 leading-relaxed">
            Prefilled with the seeded customer account (<span className="font-mono">demo@bazaarbridge.dev</span>).
            Use one-click sign in below or enter any customer credentials from PostgreSQL.
          </p>
        </div>

        {user && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
            Currently signed in as <span className="font-semibold">{user.email}</span> ({user.role}).
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void performLogin(email, password);
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="customer-email" className="block text-xs font-semibold text-[#111827]">
              Email Address
            </label>
            <input
              id="customer-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-lg border border-[#E2E8F0] px-3 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="customer-password"
              className="block text-xs font-semibold text-[#111827]"
            >
              Password
            </label>
            <input
              id="customer-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-lg border border-[#E2E8F0] px-3 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-[#DC2626]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#4F46E5] px-4 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" />
            <span>{submitting ? 'Signing in...' : 'Sign In'}</span>
          </button>

          <button
            type="button"
            disabled={submitting}
            onClick={() => void performLogin('demo@bazaarbridge.dev', 'Demo@1234')}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#4F46E5] bg-indigo-50/60 px-4 text-sm font-semibold text-[#4F46E5] transition-colors hover:bg-indigo-50 disabled:opacity-50"
          >
            <span>Enter Demo Store (One Click)</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        <div className="mt-6 border-t border-slate-100 pt-4 text-center">
          <Link
            to="/admin-login"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#64748B] hover:text-[#111827]"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>Operations Staff? Go to Admin Login →</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
