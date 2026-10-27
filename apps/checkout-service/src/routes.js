/**
 * Checkout HTTP API.
 *
 * `POST /api/checkout` is the most important endpoint in the platform: it is the
 * one that takes money. It therefore requires an Idempotency-Key, validates every
 * field, recomputes the total server-side, and returns a stable problem document
 * with the order id on failure so that support can reconcile.
 */
const orderSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sagaId: { type: 'string' },
    cartId: { type: 'string' },
    status: { type: 'string' },
    customer: { type: 'object', additionalProperties: true },
    shippingAddress: { type: 'object', additionalProperties: true },
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    pricing: { type: 'object', additionalProperties: true, nullable: true },
    payment: { type: 'object', additionalProperties: true, nullable: true },
    reservationId: { type: 'string', nullable: true },
    timeline: { type: 'array', items: { type: 'object', additionalProperties: true } },
    cancellation: { type: 'object', additionalProperties: true, nullable: true },
    failure: { type: 'object', additionalProperties: true, nullable: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
};

export async function registerRoutes({ app, service, config }) {
  app.post(
    '/api/checkout',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128 } },
        },
        body: {
          type: 'object',
          required: ['cartId', 'customer', 'shippingAddress', 'paymentMethod'],
          additionalProperties: false,
          properties: {
            cartId: { type: 'string', minLength: 3, maxLength: 80 },
            customer: {
              type: 'object',
              required: ['email', 'name'],
              additionalProperties: false,
              properties: {
                email: { type: 'string', format: 'email', maxLength: 200 },
                name: { type: 'string', minLength: 1, maxLength: 120 },
              },
            },
            shippingAddress: {
              type: 'object',
              required: ['line1', 'city', 'postalCode', 'country'],
              additionalProperties: false,
              properties: {
                line1: { type: 'string', minLength: 3, maxLength: 200 },
                line2: { type: 'string', maxLength: 200 },
                city: { type: 'string', minLength: 1, maxLength: 120 },
                state: { type: 'string', maxLength: 120 },
                postalCode: { type: 'string', minLength: 2, maxLength: 20 },
                country: { type: 'string', minLength: 2, maxLength: 2 },
              },
            },
            paymentMethod: {
              type: 'object',
              required: ['type', 'token'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['card', 'wallet', 'netbanking'] },
                token: { type: 'string', minLength: 4, maxLength: 200 },
              },
            },
          },
        },
        response: { 201: orderSchema, 200: orderSchema },
      },
    },
    async (request, reply) => {
      const { order, replayed } = await service.checkout({
        idempotencyKey: request.headers['idempotency-key'],
        cartId: request.body.cartId,
        customer: request.body.customer,
        shippingAddress: request.body.shippingAddress,
        paymentMethod: request.body.paymentMethod,
        traceId: request.id,
      });
      return reply.code(replayed ? 200 : 201).send(order);
    },
  );

  app.get('/api/orders/:orderId', { schema: { response: { 200: orderSchema } } }, async (request) => service.getOrder(request.params.orderId));

  app.get(
    '/api/orders',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            customerEmail: { type: 'string', format: 'email' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => service.listOrders(request.query),
  );

  app.post('/api/orders/:orderId/cancel', async (request) => service.cancelOrder(request.params.orderId, request.body?.reason));

  app.get('/internal/orders/stats', async () => service.repository.stats());

  app.get('/internal/checkout/config', async () => ({
    environment: config.DEPLOYMENT_ENVIRONMENT,
    stepTimeoutMs: config.STEP_TIMEOUT_MS,
  }));
}
