import { InMemoryRunStoreClient } from '../in-memory-run-store-client';
import { describeRunStoreClientContract } from './run-store-client.contract';

describeRunStoreClientContract('InMemoryRunStoreClient', () => new InMemoryRunStoreClient());
