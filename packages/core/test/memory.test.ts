import { createMemoryRepository } from '../src/repo/memory.js';
import { runRepositoryContract } from './repository.contract.js';

runRepositoryContract('memory', async () => createMemoryRepository('hh_test'));
