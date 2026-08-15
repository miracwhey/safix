/**
 * InspirationGrid Component
 * 
 * 2-column Instagram-style image grid displaying different work categories.
 * Clicking on a category shows relevant craftsmen.
 */

interface CategoryCardProps {
  title: string;
  imageUrl: string;
  onClick?: (category: string) => void;
}

const CategoryCard = ({ title, imageUrl, onClick }: CategoryCardProps) => {
  return (
    <button
      onClick={() => onClick?.(title)}
      className="relative rounded-2xl overflow-hidden shadow-md hover:shadow-xl transition-all aspect-square"
    >
      {/* Background Image */}
      <img
        src={imageUrl}
        alt={title}
        className="w-full h-full object-cover"
      />

      {/* Gradient Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />

      {/* Title */}
      <div className="absolute bottom-0 left-0 right-0 p-4">
        <h3 className="text-white font-bold text-base">{title}</h3>
      </div>
    </button>
  );
};

interface InspirationGridProps {
  onCategoryClick?: (category: string) => void;
}

export const InspirationGrid = ({ onCategoryClick }: InspirationGridProps) => {
  // Categories with image URLs
  const categories = [
    {
      title: 'Küche Reparatur',
      imageUrl: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?w=500&h=500&fit=crop',
    },
    {
      title: 'Elektrik',
      imageUrl: 'https://images.unsplash.com/photo-1621905251918-48416bd8575a?w=500&h=500&fit=crop',
    },
    {
      title: 'Wand streichen',
      imageUrl: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=500&h=500&fit=crop',
    },
    {
      title: 'Gartenarbeit',
      imageUrl: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=500&h=500&fit=crop',
    },
    {
      title: 'Möbelmontage',
      imageUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=500&h=500&fit=crop',
    },
    {
      title: 'Smart Home',
      imageUrl: 'https://images.unsplash.com/photo-1558002038-1055907df827?w=500&h=500&fit=crop',
    },
    {
      title: 'Renovierung',
      imageUrl: 'https://images.unsplash.com/photo-1581858726788-75bc0f1a4f6c?w=500&h=500&fit=crop',
    },
    {
      title: 'Boden verlegen',
      imageUrl: 'https://images.unsplash.com/photo-1615529328331-f8917597711f?w=500&h=500&fit=crop',
    },
  ];

  return (
    <div className="px-4 py-6 animate-fade-in">
      {/* Section Header */}
      <div className="mb-4">
        <h2 className="text-xl font-bold text-gray-900">Inspiration</h2>
        <p className="text-sm text-gray-600 mt-1">Entdecke Möglichkeiten für dein Zuhause</p>
      </div>

      {/* 2-Column Grid */}
      <div className="grid grid-cols-2 gap-4">
        {categories.map((category) => (
          <CategoryCard
            key={category.title}
            title={category.title}
            imageUrl={category.imageUrl}
            onClick={onCategoryClick}
          />
        ))}
      </div>
    </div>
  );
};
