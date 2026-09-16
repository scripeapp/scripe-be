import { Router } from "express";
import multer from "multer";
import { validateRequest } from "../middleware/validation.middleware";
import { storeSchemas } from "../types/store.schemas";
import {
  authenticateOptional,
  authenticateUser,
} from "../middleware/supabase-auth-middleware";
import {
  requirePermission,
  authenticateUserOrRegisterDevice,
  requireRegisterDevice,
} from "../middleware/authorize.middleware";
import { enforcePlanLimit } from "../middleware/plan-limits.middleware";
import { withSupabase } from "../types/http";
import { supabase } from "../config/supabase";
import { subscriptionController } from "../controllers/subscription.controller";
import { storeController } from "../controllers/store.controller";
import { bookingController } from "../controllers/booking.controller";
import upload, { MAX_UPLOAD_FILE_SIZE_MB } from "../middleware/upload.middleware";

const router = Router();
const uploadSingleFile = upload.single("file");
const handleSingleFileUpload: typeof uploadSingleFile = (req, res, next) => {
  uploadSingleFile(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: `File size exceeds maximum of ${MAX_UPLOAD_FILE_SIZE_MB}MB`,
      });
    }

    return res.status(400).json({
      success: false,
      error: error.message || "File upload failed",
    });
  });
};

// ============================================================================
// Store Management (Authenticated)
// ============================================================================

router.post(
  "/init",
  authenticateUser,
  // Init might be for a new business, we'll allow anyone authenticated for now
  // or require a basic 'business.member' check if we had one.
  validateRequest(storeSchemas.initStore, "body"),
  withSupabase(storeController.initializeStore.bind(storeController)),
);

router.get(
  "/me",
  authenticateUser,
  requirePermission("store.settings.read"),
  withSupabase(storeController.getUserStore.bind(storeController)),
);

router.post(
  "/save",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.saveStore, "body"),
  withSupabase(storeController.saveStore.bind(storeController)),
);

router.patch(
  "/publish",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.publishStore, "body"),
  withSupabase(storeController.publishStore.bind(storeController)),
);

router.delete(
  "/suppliers/:supplierId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.listSuppliers, "query"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  withSupabase(storeController.deleteSupplier.bind(storeController)),
);

router.get(
  "/suppliers/:supplierId/dashboard",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.listSuppliers, "query"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  withSupabase(storeController.getSupplierDashboard.bind(storeController)),
);

router.post(
  "/suppliers/:supplierId/products",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.createSupplierProduct, "body"),
  withSupabase(storeController.createSupplierProduct.bind(storeController)),
);

router.patch(
  "/suppliers/:supplierId/products/:supplierProductId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierProductParam, "params"),
  validateRequest(storeSchemas.updateSupplierProduct, "body"),
  withSupabase(storeController.updateSupplierProduct.bind(storeController)),
);

router.delete(
  "/suppliers/:supplierId/products/:supplierProductId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierProductParam, "params"),
  validateRequest(storeSchemas.listSuppliers, "query"),
  withSupabase(storeController.deleteSupplierProduct.bind(storeController)),
);

router.get(
  "/suppliers/:supplierId/receipts",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.listStockReceipts, "query"),
  withSupabase(storeController.listStockReceipts.bind(storeController)),
);

router.post(
  "/suppliers/:supplierId/receipts",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.createStockReceipt, "body"),
  withSupabase(storeController.createStockReceipt.bind(storeController)),
);

router.get(
  "/purchase-orders",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.listPurchaseOrders, "query"),
  withSupabase(storeController.listPurchaseOrders.bind(storeController)),
);

router.post(
  "/purchase-orders",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createPurchaseOrder, "body"),
  withSupabase(storeController.createPurchaseOrder.bind(storeController)),
);

router.get(
  "/purchase-orders/:purchaseOrderId",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.purchaseOrderParam, "params"),
  validateRequest(storeSchemas.listPurchaseOrders, "query"),
  withSupabase(storeController.getPurchaseOrder.bind(storeController)),
);

router.patch(
  "/purchase-orders/:purchaseOrderId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.purchaseOrderParam, "params"),
  validateRequest(storeSchemas.updatePurchaseOrder, "body"),
  withSupabase(storeController.updatePurchaseOrder.bind(storeController)),
);

router.post(
  "/purchase-orders/:purchaseOrderId/send",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.purchaseOrderParam, "params"),
  validateRequest(storeSchemas.sendPurchaseOrder, "body"),
  withSupabase(storeController.sendPurchaseOrder.bind(storeController)),
);

router.post(
  "/suppliers/:supplierId/bills",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.createSupplierBill, "body"),
  withSupabase(storeController.createSupplierBill.bind(storeController)),
);

router.patch(
  "/suppliers/:supplierId/bills/:billId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierBillParam, "params"),
  validateRequest(storeSchemas.updateSupplierBill, "body"),
  withSupabase(storeController.updateSupplierBill.bind(storeController)),
);

router.get(
  "/suppliers/:supplierId/bills",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.listSupplierBills, "query"),
  withSupabase(storeController.listSupplierBills.bind(storeController)),
);

router.get(
  "/suppliers/:supplierId/bills/:billId/items",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.supplierBillItemsParams, "params"),
  validateRequest(storeSchemas.listSupplierBills, "query"),
  withSupabase(storeController.getSupplierBillItems.bind(storeController)),
);

router.post(
  "/suppliers/:supplierId/bills/:billId/items",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierBillItemsParams, "params"),
  validateRequest(storeSchemas.addSupplierBillItem, "body"),
  withSupabase(storeController.addSupplierBillItem.bind(storeController)),
);

router.get(
  "/suppliers/:supplierId/payments",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.listSupplierPayments, "query"),
  withSupabase(storeController.listSupplierPayments.bind(storeController)),
);

router.post(
  "/suppliers/:supplierId/payments",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.createSupplierPayment, "body"),
  withSupabase(storeController.createSupplierPayment.bind(storeController)),
);

// ============================================================================
// Store-wide bills dashboard (Payments > Bill pay)
// ============================================================================

router.get(
  "/bills/metrics",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.storeIdQuery, "query"),
  withSupabase(storeController.getBillMetrics.bind(storeController)),
);

router.get(
  "/bills/:billId",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.billIdParam, "params"),
  validateRequest(storeSchemas.storeIdQuery, "query"),
  withSupabase(storeController.getBill.bind(storeController)),
);

router.get(
  "/bills",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.listBills, "query"),
  withSupabase(storeController.listBills.bind(storeController)),
);

router.post(
  "/bills",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createBill, "body"),
  withSupabase(storeController.createBill.bind(storeController)),
);

router.delete(
  "/bills/:billId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.billIdParam, "params"),
  validateRequest(storeSchemas.storeIdQuery, "query"),
  withSupabase(storeController.deleteBill.bind(storeController)),
);

router.get(
  "/bills/:billId/approval-request",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.billIdParam, "params"),
  validateRequest(storeSchemas.storeIdQuery, "query"),
  withSupabase(storeController.getBillApprovalRequest.bind(storeController)),
);

router.post(
  "/bills/:billId/pay",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.billIdParam, "params"),
  validateRequest(storeSchemas.payBill, "body"),
  withSupabase(storeController.payBill.bind(storeController)),
);

router.post(
  "/bills/:billId/approve",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.billIdParam, "params"),
  validateRequest(storeSchemas.approveBill, "body"),
  withSupabase(storeController.approveBill.bind(storeController)),
);

router.post(
  "/bills/:billId/reject",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.billIdParam, "params"),
  validateRequest(storeSchemas.rejectBill, "body"),
  withSupabase(storeController.rejectBill.bind(storeController)),
);

// ============================================================================
// Multi-Store Support (Authenticated)
// ============================================================================

router.get(
  "/list",
  authenticateUser,
  // We use requirePermission with a broad key to resolve businessId
  requirePermission("store.settings.read"),
  withSupabase(storeController.listUserStores.bind(storeController)),
);

router.post(
  "/create",
  authenticateUser,
  requirePermission("store.settings.create"),
  validateRequest(storeSchemas.createStore, "body"),
  withSupabase(storeController.createNewStore.bind(storeController)),
);

// Analytics endpoint
router.get(
  "/analytics",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getStoreAnalytics, "query"),
  withSupabase(storeController.getStoreAnalytics.bind(storeController)),
);

// Store Subaccount Override (for franchise support)
router.get(
  "/subaccount",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getStoreSubaccount, "query"),
  withSupabase(storeController.getStoreSubaccount.bind(storeController)),
);

router.patch(
  "/subaccount",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateStoreSubaccount, "body"),
  withSupabase(storeController.updateStoreSubaccount.bind(storeController)),
);

// ============================================================================
// Public Store Access (No Auth)
// ============================================================================

router.get("/public/:slug", (req, res) => {
  // Inject supabase for public access
  (req as any).supabase = supabase;
  return storeController.loadPublicStore(req, res);
});

router.get("/public/:slug/product/:productId", (req, res) => {
  // Inject supabase for public access
  (req as any).supabase = supabase;
  return storeController.loadPublicProduct(req, res);
});

// Public products listing (for storefront)
router.get("/public/:slug/products", (req, res) => {
  // Inject supabase for public access
  (req as any).supabase = supabase;
  return storeController.loadPublicProducts(req, res);
});

// Public store reviews
router.get(
  "/public/:slug/reviews",
  validateRequest(storeSchemas.getPublicReviews, "query"),
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.getPublicReviews(req, res);
  },
);

router.post(
  "/public/:slug/reviews",
  validateRequest(storeSchemas.submitReview, "body"),
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.submitReview(req, res);
  },
);

// Public store categories
router.get("/public/:slug/categories", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicCategories(req, res);
});

// Public: Get order by reference
router.get("/public/order/:reference", (req, res) => {
  // Inject supabase for public access (controller doesn't need it, but for consistency)
  (req as any).supabase = supabase;
  return storeController.getPublicOrderByReference(req, res);
});

// Public digital-product sample endpoint
router.get("/products/:productId/sample", async (req, res) => {
  const { DigitalProductService } =
    await import("../services/digital-product.service");
  const service = new DigitalProductService(supabase);
  try {
    const result = await service.getDigitalSample(req.params.productId);
    return res.json({ success: true, data: result });
  } catch (error: any) {
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
});

// Download endpoint (requires purchase verification)
router.get(
  "/orders/:orderId/download/:productId",
  authenticateOptional,
  async (req, res) => {
    const { DigitalProductService } =
      await import("../services/digital-product.service");
    const authReq = req as any;
    authReq.supabase = authReq.supabase || supabase;
    const service = new DigitalProductService(authReq.supabase);
    try {
      const result = await service.getDownloadUrl(
        req.params.orderId,
        req.params.productId,
        authReq.user_id,
        req.ip,
      );
      return res.json({ success: true, data: result });
    } catch (error: any) {
      const status = error.statusCode || 500;
      return res
        .status(status)
        .json({ success: false, message: error.message });
    }
  },
);

// Authenticated download list
router.get(
  "/downloads/my",
  authenticateUser,
  withSupabase(storeController.getUserDownloads.bind(storeController)),
);

// Generate download link (POST version)
router.post(
  "/downloads/generate/:productId",
  authenticateOptional, // Optional auth, but order_id required in body
  (req, res) => {
    (req as any).supabase = (req as any).supabase || supabase;
    return storeController.generateDownloadLink(req, res);
  },
);

// ============================================================================
// Product Management (Authenticated)
// ============================================================================

router.get(
  "/suppliers",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.listSuppliers, "query"),
  withSupabase(storeController.listSuppliers.bind(storeController)),
);

router.post(
  "/suppliers",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createSupplier, "body"),
  withSupabase(storeController.createSupplier.bind(storeController)),
);

router.patch(
  "/suppliers/:supplierId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.supplierIdParam, "params"),
  validateRequest(storeSchemas.updateSupplier, "body"),
  withSupabase(storeController.updateSupplier.bind(storeController)),
);

router.post(
  "/product",
  authenticateUser,
  requirePermission("store.product.create"),
  enforcePlanLimit("products"),
  validateRequest(storeSchemas.addProduct, "body"),
  withSupabase(storeController.addProduct.bind(storeController)),
);

router.patch(
  "/product",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.updateProduct, "body"),
  withSupabase(storeController.updateProduct.bind(storeController)),
);

router.delete(
  "/product/:productId",
  authenticateUser,
  requirePermission("store.product.delete"),
  validateRequest(storeSchemas.deleteProduct, "params"),
  withSupabase(storeController.deleteProduct.bind(storeController)),
);

// Release a pre-order product — fulfils all waiting pre_order orders
router.post(
  "/product/:productId/release",
  authenticateUser,
  requirePermission("store.product.update"),
  withSupabase(storeController.releasePreOrderProduct.bind(storeController)),
);

// List linkable items from platform modules (circles, publications, forms, consultations)
router.get(
  "/linkable-items",
  authenticateUser,
  requirePermission("store.product.read"),
  withSupabase(storeController.getModuleLinkableItems.bind(storeController)),
);

router.get(
  "/product",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.getProducts, "query"),
  withSupabase(storeController.getProducts.bind(storeController)),
);

router.get(
  "/product/:productId",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.deleteProduct, "params"), // deleteProduct schema is just {productId}
  withSupabase(storeController.getProduct.bind(storeController)),
);

router.get(
  "/product/:productId/dashboard",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.deleteProduct, "params"),
  validateRequest(storeSchemas.productDashboard, "query"),
  withSupabase(storeController.getProductDashboard.bind(storeController)),
);

router.get(
  "/product/:productId/subscribers",
  authenticateUser,
  requirePermission("store.product.read"),
  withSupabase(
    subscriptionController.getProductSubscribers.bind(subscriptionController),
  ),
);

// Per-branch catalog overrides plus normalized product/variant inventory rows.
router.get(
  "/product/:productId/branch-overrides",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.getProductBranchOverrides, "query"),
  withSupabase(storeController.getProductBranchOverrides.bind(storeController)),
);

router.put(
  "/product/:productId/branch-overrides",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.upsertProductBranchOverrides, "body"),
  withSupabase(storeController.upsertProductBranchOverrides.bind(storeController)),
);

// Upload product image
router.post(
  "/product/upload/image",
  authenticateUser,
  handleSingleFileUpload,
  requirePermission("store.product.update"),
  withSupabase(storeController.uploadProductImage.bind(storeController)),
);

// Upload product file
router.post(
  "/product/upload/file",
  authenticateUser,
  handleSingleFileUpload,
  requirePermission("store.product.update"),
  withSupabase(storeController.uploadProductFile.bind(storeController)),
);

// Create signed URL for direct product file uploads
router.post(
  "/product/upload/file/sign",
  authenticateUser,
  requirePermission("store.product.update"),
  withSupabase(
    storeController.createProductFileUploadUrl.bind(storeController),
  ),
);

// ============================================================================
// Order Management
// ============================================================================

// Public endpoint for order creation (after payment)
router.post(
  "/order/create",
  validateRequest(storeSchemas.createOrder, "body"),
  (req, res) => {
    // Inject supabase for public access
    (req as any).supabase = supabase;
    return storeController.createOrder(req, res);
  },
);

// Authenticated endpoints for order management

// Manual order creation (merchant dashboard)
router.post(
  "/order",
  authenticateUser,
  requirePermission("store.order.create"),
  validateRequest(storeSchemas.createManualOrder, "body"),
  withSupabase(storeController.createManualOrder.bind(storeController)),
);

router.get(
  "/order",
  // Also reachable by a paired /pos device (Sales/Pending Sales sidebar
  // views) — falls back to the exact same dashboard permission otherwise.
  authenticateUserOrRegisterDevice("store.order.read"),
  validateRequest(storeSchemas.getOrders, "query"),
  withSupabase(storeController.getOrders.bind(storeController)),
);

router.get(
  "/order/my-purchases",
  authenticateUser,
  withSupabase(storeController.getUserPurchases.bind(storeController)),
);

router.get(
  "/order/my-purchases/:id",
  authenticateUser,
  withSupabase(storeController.getUserPurchaseById.bind(storeController)),
);

router.get(
  "/order/:orderId",
  authenticateUser,
  requirePermission("store.order.read"),
  withSupabase(storeController.getOrderById.bind(storeController)),
);

router.patch(
  "/order/status",
  authenticateUser,
  requirePermission("store.order.update"),
  validateRequest(storeSchemas.updateOrderStatus, "body"),
  withSupabase(storeController.updateOrderStatus.bind(storeController)),
);

router.patch(
  "/order/shipping",
  authenticateUser,
  requirePermission("store.order.update"),
  validateRequest(storeSchemas.updateOrderShipping, "body"),
  withSupabase(storeController.updateOrderShipping.bind(storeController)),
);

router.patch(
  "/order/note",
  authenticateUser,
  requirePermission("store.order.update"),
  validateRequest(storeSchemas.updateOrderNote, "body"),
  withSupabase(storeController.updateOrderNote.bind(storeController)),
);

// ============================================================================
// Discount Management
// ============================================================================

// Authenticated endpoints
router.get(
  "/discount",
  authenticateUser,
  requirePermission("store.discount.read"),
  validateRequest(storeSchemas.getDiscounts, "query"),
  withSupabase(storeController.getDiscounts.bind(storeController)),
);

router.post(
  "/discount",
  authenticateUser,
  requirePermission("store.discount.create"),
  validateRequest(storeSchemas.addDiscount, "body"),
  withSupabase(storeController.addDiscountCode.bind(storeController)),
);

router.patch(
  "/discount",
  authenticateUser,
  requirePermission("store.discount.update"),
  validateRequest(storeSchemas.updateDiscount, "body"),
  withSupabase(storeController.updateDiscountCode.bind(storeController)),
);

router.delete(
  "/discount",
  authenticateUser,
  requirePermission("store.discount.delete"),
  validateRequest(storeSchemas.deleteDiscount, "body"),
  withSupabase(storeController.deleteDiscountCode.bind(storeController)),
);

// Public endpoint for discount validation (for checkout)
router.post(
  "/discount/validate",
  validateRequest(storeSchemas.validateDiscount, "body"),
  (req, res) => {
    // Inject supabase for public access
    (req as any).supabase = supabase;
    return storeController.validateDiscountCode(req, res);
  },
);

// Public endpoint for checking if any discount applies to given products
router.post(
  "/discount/applicable",
  validateRequest(storeSchemas.discountApplicable, "body"),
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.discountApplicable(req, res);
  },
);

router.post(
  "/discount/evaluate",
  validateRequest(storeSchemas.evaluateDiscounts, "body"),
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.evaluateDiscounts(req, res);
  },
);

// ============================================================================
// Store Deletion
// ============================================================================

router.delete(
  "/delete",
  authenticateUser,
  validateRequest(storeSchemas.deleteStore, "query"),
  withSupabase(storeController.deleteStore.bind(storeController)),
);

// ============================================================================
// Customer Management
// ============================================================================

router.get(
  "/customer",
  // Also reachable by a paired /pos device (Customers sidebar view).
  authenticateUserOrRegisterDevice("store.customer.read"),
  validateRequest(storeSchemas.getCustomers, "query"),
  withSupabase(storeController.getCustomers.bind(storeController)),
);

// ============================================================================
// Checkout
// ============================================================================

router.post(
  "/checkout/initiate",
  validateRequest(storeSchemas.initiateCheckout, "body"),
  (req, res) => {
    // Inject supabase for public access
    (req as any).supabase = supabase;
    return storeController.initiateCheckout(req, res);
  },
);

router.post(
  "/checkout/bank-transfer",
  validateRequest(storeSchemas.initiateCheckout, "body"),
  (req, res) => {
    // Inject supabase for public access
    (req as any).supabase = supabase;
    return storeController.initiateBankTransfer(req, res);
  },
);

router.get(
  "/checkout/:reference/status",
  validateRequest(storeSchemas.checkoutStatus, "params"),
  (req, res) => {
    // Inject supabase for public access
    (req as any).supabase = supabase;
    return storeController.getCheckoutStatus(req, res);
  },
);

router.post(
  "/checkout/free",
  validateRequest(storeSchemas.freePurchase, "body"),
  (req, res) => {
    // Inject supabase for public access
    (req as any).supabase = supabase;
    return storeController.processFreePurchase(req, res);
  },
);

// ============================================================================
// Category Management (Authenticated)
// ============================================================================

router.get(
  "/categories",
  authenticateUser,
  requirePermission("store.category.read"),
  validateRequest(storeSchemas.getCategories, "query"),
  withSupabase(storeController.getCategories.bind(storeController)),
);

router.post(
  "/categories",
  authenticateUser,
  requirePermission("store.category.create"),
  validateRequest(storeSchemas.createCategory, "body"),
  withSupabase(storeController.createCategory.bind(storeController)),
);

router.put(
  "/categories/reorder",
  authenticateUser,
  requirePermission("store.category.update"),
  validateRequest(storeSchemas.reorderCategories, "body"),
  withSupabase(storeController.reorderCategories.bind(storeController)),
);

router.put(
  "/categories/:id",
  authenticateUser,
  requirePermission("store.category.update"),
  validateRequest(storeSchemas.updateCategory, "body"),
  withSupabase(storeController.updateCategory.bind(storeController)),
);

router.delete(
  "/categories/:id",
  authenticateUser,
  requirePermission("store.category.delete"),
  validateRequest(storeSchemas.deleteCategory, "body"),
  withSupabase(storeController.deleteCategory.bind(storeController)),
);

// ============================================================================
// Store Branches (Food Store, Authenticated)
// ============================================================================

router.get(
  "/branches",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getBranches, "query"),
  withSupabase(storeController.getBranches.bind(storeController)),
);

router.post(
  "/branches",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createBranch, "body"),
  withSupabase(storeController.createBranch.bind(storeController)),
);

router.put(
  "/branches/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateBranch, "body"),
  withSupabase(storeController.updateBranch.bind(storeController)),
);

router.delete(
  "/branches/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteBranch, "body"),
  withSupabase(storeController.deleteBranch.bind(storeController)),
);

// ============================================================================
// Store QR Codes (Food Store, Authenticated)
// ============================================================================

router.get(
  "/qr-codes",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getQrCodes, "query"),
  withSupabase(storeController.getQrCodes.bind(storeController)),
);

router.post(
  "/qr-codes",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createQrCode, "body"),
  withSupabase(storeController.createQrCode.bind(storeController)),
);

router.put(
  "/qr-codes/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateQrCode, "body"),
  withSupabase(storeController.updateQrCode.bind(storeController)),
);

router.delete(
  "/qr-codes/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteQrCode, "body"),
  withSupabase(storeController.deleteQrCode.bind(storeController)),
);

// ============================================================================
// Store Menus (Food Store, Authenticated)
// ============================================================================

router.get(
  "/menus",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getMenus, "query"),
  withSupabase(storeController.getMenus.bind(storeController)),
);

router.post(
  "/menus",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createMenu, "body"),
  withSupabase(storeController.createMenu.bind(storeController)),
);

router.put(
  "/menus/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateMenu, "body"),
  withSupabase(storeController.updateMenu.bind(storeController)),
);

router.delete(
  "/menus/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteMenu, "body"),
  withSupabase(storeController.deleteMenu.bind(storeController)),
);

// ============================================================================
// Units (Authenticated)
// ============================================================================

router.get(
  "/units",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getUnits, "query"),
  withSupabase(storeController.getUnits.bind(storeController)),
);

// ============================================================================
// Modifier Groups (Food Store, Authenticated)
// ============================================================================

router.get(
  "/modifier-groups",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getModifierGroups, "query"),
  withSupabase(storeController.getModifierGroups.bind(storeController)),
);

router.post(
  "/modifier-groups",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createModifierGroup, "body"),
  withSupabase(storeController.createModifierGroup.bind(storeController)),
);

// Reorder routes must precede the `/:id` routes so "reorder" isn't matched
// as an id.
router.put(
  "/modifier-groups/reorder",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.reorderModifierGroups, "body"),
  withSupabase(storeController.reorderModifierGroups.bind(storeController)),
);

router.get(
  "/modifier-groups/:id",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getModifierGroup, "query"),
  withSupabase(storeController.getModifierGroup.bind(storeController)),
);

router.put(
  "/modifier-groups/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateModifierGroup, "body"),
  withSupabase(storeController.updateModifierGroup.bind(storeController)),
);

router.delete(
  "/modifier-groups/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteModifierGroup, "body"),
  withSupabase(storeController.deleteModifierGroup.bind(storeController)),
);

router.post(
  "/modifier-groups/:groupId/options",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createModifierOption, "body"),
  withSupabase(storeController.createModifierOption.bind(storeController)),
);

router.put(
  "/modifier-groups/:groupId/options/reorder",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.reorderModifierOptions, "body"),
  withSupabase(storeController.reorderModifierOptions.bind(storeController)),
);

router.put(
  "/modifier-groups/:groupId/options/:optionId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateModifierOption, "body"),
  withSupabase(storeController.updateModifierOption.bind(storeController)),
);

router.delete(
  "/modifier-groups/:groupId/options/:optionId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteModifierOption, "body"),
  withSupabase(storeController.deleteModifierOption.bind(storeController)),
);

// ============================================================================
// Product <-> Modifier Group attachment (Food Store, Authenticated)
// ============================================================================

router.get(
  "/products/:productId/modifier-groups",
  authenticateUser,
  requirePermission("store.settings.read"),
  withSupabase(storeController.getProductModifierGroups.bind(storeController)),
);

router.post(
  "/products/:productId/modifier-groups",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.attachModifierGroup, "body"),
  withSupabase(storeController.attachModifierGroup.bind(storeController)),
);

router.delete(
  "/products/:productId/modifier-groups/:groupId",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.detachModifierGroup, "body"),
  withSupabase(storeController.detachModifierGroup.bind(storeController)),
);

// ============================================================================
// Delivery Methods (Authenticated)
// ============================================================================

router.get(
  "/delivery-methods",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getDeliveryMethods, "query"),
  withSupabase(storeController.getDeliveryMethods.bind(storeController)),
);

router.post(
  "/delivery-methods",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createDeliveryMethod, "body"),
  withSupabase(storeController.createDeliveryMethod.bind(storeController)),
);

router.put(
  "/delivery-methods/reorder",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.reorderDeliveryMethods, "body"),
  withSupabase(storeController.reorderDeliveryMethods.bind(storeController)),
);

router.put(
  "/delivery-methods/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateDeliveryMethod, "body"),
  withSupabase(storeController.updateDeliveryMethod.bind(storeController)),
);

router.delete(
  "/delivery-methods/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteDeliveryMethod, "query"),
  withSupabase(storeController.deleteDeliveryMethod.bind(storeController)),
);

// ============================================================================
// Delivery Zones (Branch-Aware Storefront, Authenticated) — zip-code-keyed
// fee/minimum-order/ETA tables per branch, alternative to the flat-rate
// methods above.
// ============================================================================

router.get(
  "/delivery-zones",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.getDeliveryZones, "query"),
  withSupabase(storeController.getDeliveryZones.bind(storeController)),
);

router.post(
  "/delivery-zones",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.createDeliveryZone, "body"),
  withSupabase(storeController.createDeliveryZone.bind(storeController)),
);

router.put(
  "/delivery-zones/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.updateDeliveryZone, "body"),
  withSupabase(storeController.updateDeliveryZone.bind(storeController)),
);

router.delete(
  "/delivery-zones/:id",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.deleteDeliveryZone, "query"),
  withSupabase(storeController.deleteDeliveryZone.bind(storeController)),
);

// Carrier delivery (Shipbubble) — merchant settings
router.post(
  "/sender-address/validate",
  authenticateUser,
  requirePermission("store.settings.read"),
  validateRequest(storeSchemas.validateSenderAddress, "body"),
  withSupabase(storeController.validateSenderAddress.bind(storeController)),
);

router.patch(
  "/carrier-delivery",
  authenticateUser,
  requirePermission("store.settings.update"),
  validateRequest(storeSchemas.setCarrierDelivery, "body"),
  withSupabase(storeController.setCarrierDelivery.bind(storeController)),
);

// Public: Get active delivery methods for checkout
router.get("/public/:slug/delivery-methods", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicDeliveryMethods(req, res);
});

// Public: Preview a delivery zone's matched fee for a branch + zip, ahead of payment
router.get("/public/:slug/delivery-zones/match", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicDeliveryZoneMatch(req, res);
});

// Public: Get delivery rates via Shipbubble
router.get(
  "/public/:slug/delivery-rates",
  validateRequest(storeSchemas.getPublicDeliveryRates, "query"),
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.getPublicDeliveryRates(req, res);
  },
);

// ============================================================================
// Shipbubble Webhook (unauthenticated — HMAC verified)
// ============================================================================

router.post(
  "/shipbubble-webhook",
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.handleShipbubbleWebhook(req, res);
  },
);

// ============================================================================
// Store Info & Reviews (Public)
// ============================================================================

// Public: Get store info
router.get("/public/:slug/info", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicStoreInfo(req, res);
});

// Public: Get store reviews
router.get("/public/:slug/reviews", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicReviews(req, res);
});

// Public: Submit review
router.post(
  "/public/:slug/reviews",
  validateRequest(storeSchemas.submitReview, "body"),
  (req, res) => {
    (req as any).supabase = supabase;
    return storeController.submitReview(req, res);
  },
);

// ============================================================================
// Store Reviews (Merchant Dashboard)
// ============================================================================

router.get(
  "/reviews",
  authenticateUser,
  requirePermission("store.review.read"),
  validateRequest(storeSchemas.getStoreReviews, "query"),
  withSupabase(storeController.getStoreReviews.bind(storeController)),
);

router.put(
  "/reviews/:id",
  authenticateUser,
  requirePermission("store.review.update"),
  validateRequest(storeSchemas.updateReviewVisibility, "body"),
  withSupabase(storeController.updateReviewVisibility.bind(storeController)),
);

router.delete(
  "/reviews/:id",
  authenticateUser,
  requirePermission("store.review.delete"),
  validateRequest(storeSchemas.deleteReview, "query"),
  withSupabase(storeController.deleteReview.bind(storeController)),
);

// ============================================================================
// Product Variants (Authenticated)
// ============================================================================

router.get(
  "/product/:productId/variants",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.getProductVariants, "query"),
  withSupabase(storeController.getProductVariants.bind(storeController)),
);

router.post(
  "/product/:productId/variants",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.createProductVariant, "body"),
  withSupabase(storeController.createProductVariant.bind(storeController)),
);

router.put(
  "/product/:productId/variants/reorder",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.reorderProductVariants, "body"),
  withSupabase(storeController.reorderProductVariants.bind(storeController)),
);

router.put(
  "/product/:productId/variants/:variantId",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.updateProductVariant, "body"),
  withSupabase(storeController.updateProductVariant.bind(storeController)),
);

router.delete(
  "/product/:productId/variants/:variantId",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.deleteProductVariant, "query"),
  withSupabase(storeController.deleteProductVariant.bind(storeController)),
);

// ============================================================================
// Product Versions (Authenticated)
// ============================================================================

router.get(
  "/product/:productId/versions",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.getProductVersions, "query"),
  withSupabase(storeController.getProductVersions.bind(storeController)),
);

router.post(
  "/product/:productId/versions",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.createProductVersion, "body"),
  withSupabase(storeController.createProductVersion.bind(storeController)),
);

router.put(
  "/product/:productId/versions/:versionId/activate",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.activateProductVersion, "body"),
  withSupabase(storeController.activateProductVersion.bind(storeController)),
);

router.put(
  "/product/:productId/versions/:versionId",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.updateProductVersion, "body"),
  withSupabase(storeController.updateProductVersion.bind(storeController)),
);

router.delete(
  "/product/:productId/versions/:versionId",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.deleteProductVersion, "query"),
  withSupabase(storeController.deleteProductVersion.bind(storeController)),
);

// ============================================================================
// Public Variants (No Auth)
// ============================================================================

router.get("/public/:slug/product/:productId/variants", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicProductVariants(req, res);
});

router.get("/public/:slug/product/:productId/modifier-groups", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicProductModifierGroups(req, res);
});

router.get("/public/:slug/branches", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicStoreBranches(req, res);
});

router.get("/public/:slug/menus", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicStoreMenus(req, res);
});

router.get("/public/:slug/qr/:code", (req, res) => {
  (req as any).supabase = supabase;
  return storeController.getPublicStoreQrCode(req, res);
});

// ============================================================================
// Service Bookings (Authenticated)
// ============================================================================

// Reserve a slot for 15 minutes while the customer fills checkout details (public — no auth)
router.post("/bookings/reserve", (req, res) => {
  (req as any).supabase = supabase;
  return bookingController.reserveBookingSlot(req, res);
});

// Initiate payment for a standalone booking (not via store cart)
router.post("/bookings/initiate-payment", (req, res) => {
  (req as any).supabase = supabase;
  return bookingController.initiateBookingPayment(req, res);
});

// Public — used by the order-success page to show booking details
router.get("/public/booking/:bookingId", (req, res) =>
  bookingController.getPublicBooking(req, res),
);

// Public — ICS calendar download for a confirmed booking
router.get("/public/booking/:bookingId/calendar", (req, res) =>
  bookingController.getPublicBookingCalendar(req, res),
);

// Get store bookings with filters
router.get(
  "/bookings",
  authenticateUser,
  requirePermission("store.order.view"),
  withSupabase(bookingController.getStoreBookings.bind(bookingController)),
);

// Get booking details
router.get(
  "/bookings/:bookingId",
  authenticateUser,
  requirePermission("store.order.view"),
  withSupabase(bookingController.getBooking.bind(bookingController)),
);

// Update booking status
router.patch(
  "/bookings/:bookingId/status",
  authenticateUser,
  requirePermission("store.order.update"),
  withSupabase(bookingController.updateBookingStatus.bind(bookingController)),
);

// Reschedule booking
router.post(
  "/bookings/:bookingId/reschedule",
  authenticateUser,
  requirePermission("store.order.update"),
  withSupabase(bookingController.rescheduleBooking.bind(bookingController)),
);

// Send reminder for booking
router.post(
  "/bookings/:bookingId/reminder",
  authenticateUser,
  requirePermission("store.order.update"),
  withSupabase(bookingController.sendReminder.bind(bookingController)),
);

// Customer's own bookings (must be before :bookingId route)
router.get(
  "/bookings/my",
  authenticateUser,
  withSupabase(bookingController.getMyBookings.bind(bookingController)),
);

// ============================================================================
// Inventory Management (Authenticated)
// ============================================================================

router.get(
  "/inventory/products",
  authenticateUser,
  requirePermission("store.product.read"),
  withSupabase(storeController.getInventoryProducts.bind(storeController)),
);

router.get(
  "/inventory/movements",
  authenticateUser,
  requirePermission("store.product.read"),
  withSupabase(storeController.getInventoryMovements.bind(storeController)),
);

router.post(
  "/inventory/update",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.updateInventory, "body"),
  withSupabase(storeController.updateInventory.bind(storeController)),
);

router.get(
  "/inventory/low-stock",
  authenticateUser,
  requirePermission("store.product.read"),
  withSupabase(storeController.getLowStockProducts.bind(storeController)),
);

router.get(
  "/inventory/transfers",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.listStockTransfers, "query"),
  withSupabase(storeController.listTransfers.bind(storeController)),
);

router.get(
  "/inventory/transfers/:id",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.stockTransferIdParams, "params"),
  validateRequest(storeSchemas.getStockTransfer, "query"),
  withSupabase(storeController.getTransfer.bind(storeController)),
);

router.post(
  "/inventory/transfers",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.createStockTransfer, "body"),
  withSupabase(storeController.createTransfer.bind(storeController)),
);

router.post(
  "/inventory/transfers/:id/send",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.stockTransferIdParams, "params"),
  validateRequest(storeSchemas.sendStockTransfer, "body"),
  withSupabase(storeController.sendTransfer.bind(storeController)),
);

router.post(
  "/inventory/transfers/:id/receive",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.stockTransferIdParams, "params"),
  validateRequest(storeSchemas.receiveStockTransfer, "body"),
  withSupabase(storeController.receiveTransfer.bind(storeController)),
);

router.post(
  "/inventory/transfers/:id/cancel",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.stockTransferIdParams, "params"),
  validateRequest(storeSchemas.cancelStockTransfer, "body"),
  withSupabase(storeController.cancelTransfer.bind(storeController)),
);

router.get(
  "/inventory/stock-counts",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.listStockCounts, "query"),
  withSupabase(storeController.listStockCounts.bind(storeController)),
);

router.get(
  "/inventory/stock-counts/:id",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(storeSchemas.stockCountIdParams, "params"),
  validateRequest(storeSchemas.getStockCount, "query"),
  withSupabase(storeController.getStockCount.bind(storeController)),
);

router.post(
  "/inventory/stock-counts",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.createStockCount, "body"),
  withSupabase(storeController.createStockCount.bind(storeController)),
);

router.post(
  "/inventory/stock-counts/:id/lines",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.stockCountIdParams, "params"),
  validateRequest(storeSchemas.addStockCountLine, "body"),
  withSupabase(storeController.addStockCountLine.bind(storeController)),
);

router.post(
  "/inventory/stock-counts/:id/apply",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.stockCountIdParams, "params"),
  validateRequest(storeSchemas.applyStockCount, "body"),
  withSupabase(storeController.applyStockCount.bind(storeController)),
);

router.post(
  "/inventory/stock-counts/:id/cancel",
  authenticateUser,
  requirePermission("store.product.update"),
  validateRequest(storeSchemas.stockCountIdParams, "params"),
  validateRequest(storeSchemas.cancelStockCount, "body"),
  withSupabase(storeController.cancelStockCount.bind(storeController)),
);

// ============================================================================
// Registers — named till devices
// ============================================================================

router.get(
  "/registers",
  authenticateUser,
  requirePermission("store.register.operate"),
  validateRequest(storeSchemas.listRegisters, "query"),
  withSupabase(storeController.listRegisters.bind(storeController)),
);

router.post(
  "/registers",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.createRegister, "body"),
  withSupabase(storeController.createRegister.bind(storeController)),
);

router.patch(
  "/registers/:registerId",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.registerIdParam, "params"),
  validateRequest(storeSchemas.updateRegister, "body"),
  withSupabase(storeController.updateRegister.bind(storeController)),
);

router.delete(
  "/registers/:registerId",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.registerIdParam, "params"),
  withSupabase(storeController.deleteRegister.bind(storeController)),
);

router.post(
  "/registers/:registerId/pairing-code",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.registerIdParam, "params"),
  withSupabase(storeController.generateRegisterPairingCode.bind(storeController)),
);

router.post(
  "/registers/:registerId/unpair",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.registerIdParam, "params"),
  withSupabase(storeController.unpairRegisterDevice.bind(storeController)),
);

// POS overview — registers, open sessions, and sales analytics for the
// store tab's Point of Sale sub-tab.
router.get(
  "/pos/analytics",
  authenticateUser,
  requirePermission("store.settings.read"),
  withSupabase(storeController.getPosAnalytics.bind(storeController)),
);

// ============================================================================
// Staff PINs — who's actually operating an already-paired till.
// ============================================================================

router.get(
  "/pos-staff",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.listPosStaff, "query"),
  withSupabase(storeController.listPosStaff.bind(storeController)),
);

router.post(
  "/pos-staff",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.createPosStaff, "body"),
  withSupabase(storeController.createPosStaff.bind(storeController)),
);

router.patch(
  "/pos-staff/:staffId",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.staffIdParam, "params"),
  validateRequest(storeSchemas.updatePosStaff, "body"),
  withSupabase(storeController.updatePosStaff.bind(storeController)),
);

router.delete(
  "/pos-staff/:staffId",
  authenticateUser,
  requirePermission("store.register.manage"),
  validateRequest(storeSchemas.staffIdParam, "params"),
  withSupabase(storeController.deletePosStaff.bind(storeController)),
);

// ============================================================================
// POS device pairing — a cashier's device exchanges a merchant-issued code
// for a long-lived token here, with no dashboard login at all.
// ============================================================================

router.post(
  "/pos/pair",
  validateRequest(storeSchemas.pairRegisterDevice, "body"),
  withSupabase(storeController.pairRegisterDevice.bind(storeController)),
);

router.get(
  "/pos/session",
  requireRegisterDevice(),
  withSupabase(storeController.getPosSession.bind(storeController)),
);

router.post(
  "/pos/staff/verify-pin",
  requireRegisterDevice(),
  validateRequest(storeSchemas.verifyPosStaffPin, "body"),
  withSupabase(storeController.verifyPosStaffPin.bind(storeController)),
);

// ============================================================================
// Register shifts (POS till sessions) — reachable by a logged-in dashboard
// staff member OR a paired device via /pos, see
// authenticateUserOrRegisterDevice.
// ============================================================================

router.post(
  "/register/shift/open",
  authenticateUserOrRegisterDevice("store.register.operate"),
  validateRequest(storeSchemas.openRegisterShift, "body"),
  withSupabase(storeController.openRegisterShift.bind(storeController)),
);

router.post(
  "/register/shift/close",
  authenticateUserOrRegisterDevice("store.register.operate"),
  validateRequest(storeSchemas.closeRegisterShift, "body"),
  withSupabase(storeController.closeRegisterShift.bind(storeController)),
);

router.get(
  "/register/shift/current",
  authenticateUserOrRegisterDevice("store.register.operate"),
  validateRequest(storeSchemas.getCurrentRegisterShift, "query"),
  withSupabase(storeController.getCurrentRegisterShift.bind(storeController)),
);

router.get(
  "/register/shift/:shiftId/summary",
  authenticateUserOrRegisterDevice("store.register.operate"),
  validateRequest(storeSchemas.shiftIdParam, "params"),
  withSupabase(storeController.getRegisterShiftSummary.bind(storeController)),
);

router.post(
  "/pos/order/preview",
  authenticateUserOrRegisterDevice("store.register.operate"),
  validateRequest(storeSchemas.previewPosOrder, "body"),
  withSupabase(storeController.previewPosOrder.bind(storeController)),
);

router.post(
  "/pos/order",
  authenticateUserOrRegisterDevice("store.register.operate"),
  validateRequest(storeSchemas.createPosOrder, "body"),
  withSupabase(storeController.createPosOrder.bind(storeController)),
);

// ============================================================================
// Get Specific Store (By ID)
// ============================================================================

router.get(
  "/:storeId",
  authenticateUser,
  validateRequest(storeSchemas.getStoreById, "params"),
  withSupabase(storeController.getStoreById.bind(storeController)),
);

export default router;
