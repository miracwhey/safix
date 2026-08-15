/**
 * EscrowInfo Component
 * 
 * Mini escrow section with animated illustration.
 * Explains the secure payment process for customers.
 */
export const EscrowInfo = () => {
  return (
    <div className="px-4 py-4 animate-fade-in">
      <div className="flex items-center space-x-4 p-4 bg-white rounded-2xl shadow-md border border-gray-100">
        {/* Animated Icon */}
        <div className="flex-shrink-0">
          <div className="w-14 h-14 bg-gradient-to-br from-primary-100 to-primary-200 rounded-full flex items-center justify-center animate-pulse">
            <svg
              className="w-8 h-8 text-primary-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
        </div>

        {/* Info Text */}
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-gray-900">
            Sicher bezahlen mit Stripe
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            Geld wird erst nach abgeschlossener Arbeit freigegeben.
          </p>
        </div>
      </div>
    </div>
  );
};
