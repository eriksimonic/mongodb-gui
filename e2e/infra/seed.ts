import { MongoClient } from 'mongodb';

export async function seedShop(uri: string): Promise<void> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const orders = client.db('shop').collection('orders');
    await orders.deleteMany({});
    await orders.insertMany([
      { orderNumber: 1, status: 'paid', total: 1200 },
      { orderNumber: 2, status: 'open', total: 450 },
      { orderNumber: 3, status: 'paid', total: 980 },
    ]);
    await orders.createIndex({ status: 1 }, { name: 'status_1' });
  } finally {
    await client.close();
  }
}
