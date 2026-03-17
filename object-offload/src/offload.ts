import * as restate from "@restatedev/restate-sdk";

/** Values larger than this will be offloaded to object store */
export const OFFLOAD_THRESHOLD = 1024 * 1024;

/** The path to offloaded large data, and a tag for the data type */
export type Offload = {
    _isOffload: true;
    url: string
}

/** A value that may be either an in-memory value or offloaded to an object store */
export type MaybeOffloaded<T> = T | Offload;

/**
 * A type that contains
 * (a) the actual value, to use in the code (`value`)
 * (b) a possibly offloaded version of the value (`maybeOffloadedValue`) mainly used in
 *     case the code needs to pass the reference to the value to other handlers
 * 
 * For non-offloaded types, (a) and (b) point to the same object
 */
export type Result<T> = {
    value: T;
    maybeOffloadedValue: MaybeOffloaded<T>;
}

export type ObjectStore = {
    uploadToObjectStore: (data: Uint8Array) => Promise<string>,
    downloadFromObjectStore: (path: string) => Promise<Uint8Array>
}

export async function mayBeOffload<T>(
        ctx: restate.Context,
        objectStore: ObjectStore,
        name: string,
        action: () => Promise<T>,
        options?: restate.RunOptions<T>): Promise<Result<T>> {

    // LIMITATION: Currently works only with JSON serde, can extend this util in the future
    // to support other serde types
    if (!(options?.serde === undefined || options?.serde === restate.serde.json)) {
        throw new Error("Currently works only with JSON serde");
    }
    const serde = options?.serde ?? restate.serde.json;

    // options that are the same (in terms of retries, etc.) as the original ones,
    // but set a binary serde instead
    const binarySerdeOptions = { ...(options ?? {}), serde: restate.serde.binary }

    let result: Result<T> | undefined;

    const durableResult = await ctx.run(name, async () => {
            const r = await action();   // execute actual action

            // eagerly serialize
            const serialized = serde.serialize(r);

            // offload if needed
            if (serialized.byteLength >= OFFLOAD_THRESHOLD) {
                const url = await objectStore.uploadToObjectStore(serialized);
                const resObj: Offload = { _isOffload: true, url };
                result = { value: r, maybeOffloadedValue: resObj } // side channel out, for efficiency
                return restate.serde.json.serialize(resObj);
            } else {
                result = { value: r, maybeOffloadedValue: r }; // side channel out, for efficiency
                return serialized;
            }
        },
        binarySerdeOptions
    )

    if (result) {
        // we created this and have it cached
        return result;
    }

    // we restored form journal
    const maybeOffloadedValue: MaybeOffloaded<T> = serde.deserialize(durableResult);
    if (isOffload(maybeOffloadedValue)) {
        // offloaded, read back the from object store
        const bytes = await objectStore.downloadFromObjectStore(maybeOffloadedValue.url);
        const value = serde.deserialize(bytes);
        return { value, maybeOffloadedValue };   
    } else {
        // in-line value
        return { value: maybeOffloadedValue, maybeOffloadedValue };
    }
}

function isOffload(value: unknown): value is Offload {
    return typeof value === 'object' && value !== null && '_isOffload' in value && (value as any)._isOffload === true;
}
