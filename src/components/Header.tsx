type HeaderProps = {
  onSearch?: (query: string) => void;
};

export default function Header({ onSearch }: HeaderProps) {
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSearch) return;
    const data = new FormData(event.currentTarget);
    const query = (data.get('query') as string) || '';
    onSearch(query.trim());
  };

  return (
    <header
      style={{
        background: 'linear-gradient(180deg, #EEF4FF 0%, #F6F7FB 70%, #F5F6FA 100%)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 20,
      }}
    >
      <div
        style={{
          padding: '20px 16px 0',
          maxWidth: 520,
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        {/* Branding */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 14,
              backgroundColor: 'var(--blue)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 20px rgba(37, 99, 235, 0.25)',
              flex: '0 0 auto',
            }}
          >
            <span style={{ color: '#fff', fontSize: 22 }}>⚡</span>
          </div>

          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a' }}>
              SaFix
            </div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
              Handwerker. Sicher. Einfach.
            </div>
          </div>
        </div>

        {/* Search */}
        <form onSubmit={handleSubmit}>
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: 999,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              boxShadow: 'var(--shadow)',
            }}
          >
            <span style={{ fontSize: 18, opacity: 0.5 }}>🔍</span>
            <input
              name="query"
              type="text"
              placeholder="Handwerker suchen oder KI fragen..."
              style={{
                border: 'none',
                outline: 'none',
                width: '100%',
                fontSize: 15,
                color: '#0f172a',
                background: 'transparent',
              }}
            />
          </div>
        </form>
      </div>
    </header>
  );
}
