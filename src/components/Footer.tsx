import { Link } from 'react-router-dom';
import { useSystem } from '../context/SystemContext';

export function Footer() {
  const { isFeatureEnabled } = useSystem();

  return (
    <footer className="mt-20 border-t border-[#E2E8F0] bg-white">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-4">
          <div className="md:col-span-2">
            <p className="font-display text-lg font-bold text-[#111827]">BazaarBridge</p>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-[#64748B]">
              Multi-dealer electronics marketplace connecting shoppers with verified local dealers
              through atomic stock reservations and hybrid Quick, Standard, and Transfer
              fulfilment.
            </p>
            <p className="mt-3 text-xs text-[#64748B]">
              All seeded dealers, stock quantities, hubs, delivery fees, and demo OTPs are labelled
              SAMPLE or SIMULATED.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold tracking-wider text-[#111827] uppercase">
              Marketplace
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-[#64748B]">
              <li>
                <Link to="/products" className="hover:text-[#111827]">
                  Browse Catalog
                </Link>
              </li>
              <li>
                <Link to="/compare" className="hover:text-[#111827]">
                  Dealer Comparison
                </Link>
              </li>
              <li>
                <Link to="/outside-bangalore" className="hover:text-[#111827]">
                  Outside Bangalore Stock
                </Link>
              </li>
              <li>
                <Link to="/orders" className="hover:text-[#111827]">
                  Order Tracking
                </Link>
              </li>
              {isFeatureEnabled('FEATURE_WISHLIST') && (
                <li>
                  <Link to="/wishlist" className="hover:text-[#111827]">
                    Saved Wishlist
                  </Link>
                </li>
              )}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold tracking-wider text-[#111827] uppercase">
              Operations & Support
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-[#64748B]">
              <li>
                <Link to="/admin-login" className="hover:text-[#111827]">
                  Admin Simulator Console
                </Link>
              </li>
              {isFeatureEnabled('FEATURE_SIM_SCREENS') && (
                <li>
                  <Link to="/simulated" className="hover:text-[#111827]">
                    Sample Operations Screens
                  </Link>
                </li>
              )}
              <li>
                <Link to="/products?q=bluetoth" className="hover:text-[#111827]">
                  How BazaarBridge Works
                </Link>
              </li>
              <li>
                <span>Support: support@bazaarbridge.dev</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-[#E2E8F0] pt-6 text-xs text-[#64748B] sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} BazaarBridge Marketplace. Privacy Policy · Terms & Conditions</p>
          <p>Powered by Aiven PostgreSQL, Kafka, and OpenSearch</p>
        </div>
      </div>
    </footer>
  );
}
