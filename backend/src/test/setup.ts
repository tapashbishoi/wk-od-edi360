// Placeholders so modules that import config/env load under test. No test
// touches a database or broker.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.WK_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.RABBITMQ_URL ||= 'amqp://guest:guest@localhost:5672';
process.env.NODE_ENV = 'test';
