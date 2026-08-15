// Navigation types
export type NavItem = 'home' | 'explore' | 'search' | 'jobs' | 'messages' | 'profile';

// User types - placeholder for future authentication integration
export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

// Job types - placeholder for future job posting integration
export interface Job {
  id: string;
  title: string;
  description: string;
  price: number;
  location: string;
  postedBy: string;
  createdAt: Date;
}

// Message types - placeholder for future chat integration
export interface Message {
  id: string;
  senderId: string;
  receiverId: string;
  content: string;
  timestamp: Date;
  read: boolean;
}

// Escrow types - placeholder for future payment integration
export interface EscrowTransaction {
  id: string;
  jobId: string;
  amount: number;
  status: 'pending' | 'held' | 'released' | 'disputed';
  createdAt: Date;
}

// Craftsman types - for Reels feature
export interface Craftsman {
  id: string;
  name: string;
  avatar: string;
  profession: string;
  rating?: number;
  completedJobs?: number;
}

// Reels Post types - for ExploreFeed feature
export interface ReelsPost {
  id: string;
  projectTitle: string;
  description: string;
  city: string;
  priceRange: string;
  imageUrl: string;
  craftsman: Craftsman;
  likes: number;
  comments: number;
  isLiked?: boolean;
  isSaved?: boolean;
}
