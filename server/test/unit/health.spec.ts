import request from 'supertest';
import { app } from '../../src/app';

describe('GET /api/health', () => {
  it('returns 200 with health payload', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'ok',
        service: 'ast-server',
      }),
    );
    expect(typeof response.body.timestamp).toBe('string');
  });
});
