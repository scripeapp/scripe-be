import { Router } from 'express';
import { 
  getAllPosts, 
  getAllNotes,
  getMarketplaceProducts,
  getMarketplaceStores,
  getMarketplaceCategories,
  getMarketplaceCollections,
  getMarketplaceOrders,
  getMarketplaceOrderDetails,
  getMarketplaceWishlist,
  toggleWishlist,
  removeFromWishlist
} from '../controllers/marketplace.controller';
import { withSupabase } from '../types/http';
import { authenticateUser, authenticateOptional } from '../middleware/supabase-auth-middleware';

const router = Router();

// Marketplace feed endpoints - all public, filtered by marketplace_visibility
router.get('/posts', authenticateOptional, withSupabase(getAllPosts));
router.get('/notes', authenticateOptional, withSupabase(getAllNotes));

// Store Marketplace endpoints
router.get('/products', authenticateOptional, withSupabase(getMarketplaceProducts));
router.get('/stores', authenticateOptional, withSupabase(getMarketplaceStores));
router.get('/categories', authenticateOptional, withSupabase(getMarketplaceCategories));
router.get('/collections', authenticateOptional, withSupabase(getMarketplaceCollections));

// Order endpoints (Authenticated)
router.get('/orders', authenticateUser, withSupabase(getMarketplaceOrders));
router.get('/orders/:id', authenticateUser, withSupabase(getMarketplaceOrderDetails));

// Wishlist endpoints (Authenticated)
router.get('/wishlist', authenticateUser, withSupabase(getMarketplaceWishlist));
router.post('/wishlist', authenticateUser, withSupabase(toggleWishlist));
router.delete('/wishlist/:productId', authenticateUser, withSupabase(removeFromWishlist));

export default router;
