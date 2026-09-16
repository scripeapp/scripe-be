// Jest setup file for global mocks and configuration

// Mock environment variables
process.env.PAYSTACK_SECRET_KEY = 'test_secret_key';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test_anon_key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_service_role_key';

// Silence console during tests (optional - comment out for debugging)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn(),
// };

// Note: If you need to set test timeout, use jest.config.js testTimeout option instead

