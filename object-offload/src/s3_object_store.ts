import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import * as crypto from "crypto";
import { TerminalError } from "@restatedev/restate-sdk";
import { ObjectStore } from "./offload";

const NON_RETRYABLE_S3_ERROR_NAMES = new Set([
  "AccessDenied",
  "AccountProblem",
  "AllAccessDisabled",
  "InvalidAccessKeyId",
  "InvalidBucketName",
  "InvalidBucketState",
  "InvalidObjectState",
  "InvalidPayer",
  "InvalidSecurity",
  "NoSuchBucket",
  "NotSignedUp",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "TokenRefreshRequired",
]);

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly maxRetries: number;

  constructor(options: {
    bucket: string;
    keyPrefix?: string;
    region?: string;
    maxRetries?: number;
  }) {
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? "restate-offload/";
    this.maxRetries = options.maxRetries ?? 3;

    this.client = new S3Client({
      region: options.region,
      // SDK's built-in retries are disabled so we control retry logic
      // and can distinguish retryable vs. terminal errors ourselves.
      maxAttempts: 1,
    });
  }

  async uploadToObjectStore(data: Uint8Array): Promise<string> {
    const key = `${this.keyPrefix}${Date.now()}-${crypto.randomUUID()}.bin`;

    await this.retryOperation(async () => {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentLength: data.byteLength,
        })
      );
    }, "S3 Upload");

    return `s3://${this.bucket}/${key}`;
  }

  async downloadFromObjectStore(uri: string): Promise<Uint8Array> {
    const { bucket, key } = S3ObjectStore.parseS3Uri(uri);

    return this.retryOperation(async () => {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      return new Uint8Array(await response.Body!.transformToByteArray());
    }, "S3 Download");
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
        if (S3ObjectStore.isNonRetryableError(error)) {
          throw new TerminalError(
            `${operationName} failed with non-retryable error: ${error instanceof Error ? error.message : String(error)}`,
            { errorCode: error instanceof S3ServiceException ? error.$metadata.httpStatusCode ?? 500 : 500 }
          );
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 100)
          );
        }
      }
    }

    throw new Error(
      `${operationName} failed after ${this.maxRetries} local retry attempts: ${lastError?.message}`
    );
  }

  private static isNonRetryableError(error: unknown): boolean {
    if (!(error instanceof S3ServiceException)) {
      return false;
    }
    if (NON_RETRYABLE_S3_ERROR_NAMES.has(error.name)) {
      return true;
    }
    const status = error.$metadata.httpStatusCode;
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return true;
    }
    return false;
  }

  private static parseS3Uri(uri: string): { bucket: string; key: string } {
    const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new TerminalError(`Invalid S3 URI: ${uri}`);
    }
    return { bucket: match[1], key: match[2] };
  }
}
