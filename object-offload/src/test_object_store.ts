import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { ObjectStore } from "./offload";

export class LocalFileObjectStore implements ObjectStore {
  private readonly baseDir: string;
  private readonly maxRetries = 3;

  constructor() {
    this.baseDir = path.join(os.tmpdir(), "restate-object-store");
  }

  private async ensureBaseDir(): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
    } catch (error) {
      // Ignore if directory already exists
    }
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
        }
      }
    }
    
    throw new Error(
      `${operationName} failed after ${this.maxRetries} attempts: ${lastError?.message}`
    );
  }

  async uploadToObjectStore(data: Uint8Array): Promise<string> {
    await this.ensureBaseDir();
    
    return this.retryOperation(async () => {
      const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.bin`;
      const filepath = path.join(this.baseDir, filename);
      await fs.writeFile(filepath, data);
      return filepath;
    }, "Upload");
  }

  async downloadFromObjectStore(filepath: string): Promise<Uint8Array> {
    return this.retryOperation(async () => {
      const data = await fs.readFile(filepath);
      return new Uint8Array(data);
    }, "Download");
  }
}