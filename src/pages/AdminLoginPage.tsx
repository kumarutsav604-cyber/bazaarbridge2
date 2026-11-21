import { Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export function AdminLoginPage() {
  const { login, logout } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();

  // Admin credentials are NEVER prefilled
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await login(email.trim(), password);
      if (user.role !== 'admin') {
        logout();
        setError('This account does not have admin privileges.');
        return;
      }
      addToast('Admin session authenticated.', 'success');
      navigate('/admin', { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Admin authentication failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wider text-[#111827] uppercase">
              Restricted Operations
            </p>
            <h1 className="mt-1 font-display text-2xl font-bold text-[#111827]">
              Admin Simulator Login
            </h1>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-[#111827]">
            <ShieldCheck className="h-5 w-5" />
          </div>
        </div>

        <p className="mb-5 text-xs leading-relaxed text-[#64748B]">
          Enter your configured admin credentials (<span className="font-mono">SEED_ADMIN_EMAIL</span>{' '}
          / <span className="font-mono">SEED_ADMIN_PASSWORD</span>) to access fulfilment simulators,
          hub controls, refund credits, and Kafka/OpenSearch live proof diagnostics.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-email" className="block text-xs font-semibold text-[#111827]">
              Admin Email
            </label>
            <input
              id="admin-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@bazaarbridge.dev"
              className="mt-1.5 h-10 w-full rounded-lg border border-[#E2E8F0] px-3 text-sm text-[#111827] focus:border-[#4F46E5] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="admin-password" className="block text-xs font-semibold text-[#111827]">
              Admin Password
            </label>
            <input
              id="admin-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin password"
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
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#111827] px-4 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
          >
            <Lock className="h-4 w-4" />
            <span>{submitting ? 'Verifying...' : 'Sign In as Admin'}</span>
          </button>
        </form>

        <div className="mt-6 border-t border-slate-100 pt-4 text-center">
          <Link to="/login" className="text-xs font-medium text-[#4F46E5] hover:underline">
            ← Back to Customer Sign In
          </Link>
        </div>
      </div>
    </main>
  );
}
