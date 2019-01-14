"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const bluebird_1 = require("bluebird");
const file_disk_1 = require("file-disk");
const GPT = require("gpt");
const MBR = require("mbr");
const typed_error_1 = require("typed-error");
/**
 * @module partitioninfo
 */
const MBR_SIZE = 512;
const GPT_SIZE = 512 * 41;
const GPT_PROTECTIVE_MBR = 0xee;
const MBR_LAST_PRIMARY_PARTITION = 4;
const MBR_FIRST_LOGICAL_PARTITION = 5;
function mbrPartitionDict(p, offset, index) {
    return {
        offset: offset + p.byteOffset(),
        size: p.byteSize(),
        type: p.type,
        index,
    };
}
function gptPartitionDict(gpt, p, index) {
    return {
        offset: p.firstLBA * gpt.blockSize,
        size: (p.lastLBA - p.firstLBA + 1) * gpt.blockSize,
        type: p.type,
        index,
    };
}
// Only for MBR
function getPartitionsFromMBRBuf(buf) {
    return new MBR(buf).partitions.filter(p => p.type);
}
function readFromDisk(disk, offset, size) {
    return __awaiter(this, void 0, void 0, function* () {
        const { buffer } = yield disk.read(Buffer.alloc(size), 0, size, offset);
        return buffer;
    });
}
// Only for MBR
function getLogicalPartitions(disk, index, offset, extendedPartitionOffset, limit) {
    return __awaiter(this, void 0, void 0, function* () {
        if (extendedPartitionOffset === undefined) {
            extendedPartitionOffset = offset;
        }
        if (limit === undefined) {
            limit = Infinity;
        }
        const result = [];
        if (limit <= 0) {
            return result;
        }
        const buf = yield readFromDisk(disk, offset, MBR_SIZE);
        for (const p of getPartitionsFromMBRBuf(buf)) {
            if (!p.extended) {
                result.push(mbrPartitionDict(p, offset, index));
            }
            else if (limit > 0) {
                const logicalPartitions = yield getLogicalPartitions(disk, index + 1, extendedPartitionOffset + p.byteOffset(), extendedPartitionOffset, limit - 1);
                result.push(...logicalPartitions);
                return result;
            }
        }
        return result;
    });
}
function detectGPT(buffer) {
    let blockSize = MBR_SIZE;
    // Attempt to parse the GPT from several offsets,
    // as the block size of the image may vary (512,1024,2048,4096);
    // For example, ISOs will usually have a block size of 4096,
    // but raw images a block size of 512 bytes
    let lastError;
    while (blockSize <= 4096) {
        try {
            return GPT.parse(buffer.slice(blockSize));
        }
        catch (error) {
            lastError = error;
        }
        blockSize *= 2;
    }
    throw lastError;
}
function getDiskPartitions(disk, { offset, includeExtended, getLogical, }) {
    return __awaiter(this, void 0, void 0, function* () {
        let extended = null;
        const mbrBuf = yield readFromDisk(disk, offset, MBR_SIZE);
        const partitions = getPartitionsFromMBRBuf(mbrBuf);
        if (partitions.length === 1 && partitions[0].type === GPT_PROTECTIVE_MBR) {
            const gptBuf = yield readFromDisk(disk, 0, GPT_SIZE);
            const gpt = detectGPT(gptBuf);
            return {
                type: 'gpt',
                partitions: gpt.partitions.map((partition, index) => gptPartitionDict(gpt, partition, index + 1)),
            };
        }
        else {
            const mbrPartitions = [];
            for (let index = 0; index < partitions.length; index++) {
                const p = partitions[index];
                if (p.extended) {
                    extended = p;
                    if (includeExtended) {
                        mbrPartitions.push(mbrPartitionDict(p, offset, index + 1));
                    }
                }
                else {
                    mbrPartitions.push(mbrPartitionDict(p, offset, index + 1));
                }
            }
            if (extended != null && getLogical) {
                const logicalPartitions = yield getLogicalPartitions(disk, MBR_FIRST_LOGICAL_PARTITION, extended.byteOffset());
                mbrPartitions.push(...logicalPartitions);
            }
            return { type: 'mbr', partitions: mbrPartitions };
        }
    });
}
class PartitionNotFound extends typed_error_1.TypedError {
    constructor(partitionNumber) {
        super(`Partition not found: ${partitionNumber}.`);
    }
}
exports.PartitionNotFound = PartitionNotFound;
function getPartition(disk, partitionNumber) {
    return __awaiter(this, void 0, void 0, function* () {
        if (partitionNumber < 1) {
            throw new Error('The partition number must be at least 1.');
        }
        const info = yield getDiskPartitions(disk, {
            includeExtended: true,
            offset: 0,
            getLogical: false,
        });
        if (info.type === 'gpt') {
            if (info.partitions.length < partitionNumber) {
                throw new PartitionNotFound(partitionNumber);
            }
            else {
                return info.partitions[partitionNumber - 1];
            }
        }
        if (partitionNumber <= MBR_LAST_PRIMARY_PARTITION) {
            if (partitionNumber <= info.partitions.length) {
                return info.partitions[partitionNumber - 1];
            }
            else {
                throw new PartitionNotFound(partitionNumber);
            }
        }
        const extended = info.partitions.find(p => MBR.Partition.isExtended(p.type));
        if (!extended) {
            throw new PartitionNotFound(partitionNumber);
        }
        else {
            const logicalPartitionPosition = partitionNumber - MBR_FIRST_LOGICAL_PARTITION;
            const logicalPartitions = yield getLogicalPartitions(disk, MBR_FIRST_LOGICAL_PARTITION, extended.offset, extended.offset, logicalPartitionPosition + 1);
            if (logicalPartitionPosition < logicalPartitions.length) {
                return logicalPartitions[logicalPartitionPosition];
            }
            else {
                throw new PartitionNotFound(partitionNumber);
            }
        }
    });
}
function isString(x) {
    return typeof x === 'string';
}
function callWithDisk(fn, pathOrBufferOrDisk, arg) {
    return __awaiter(this, void 0, void 0, function* () {
        if (isString(pathOrBufferOrDisk)) {
            return yield bluebird_1.using(file_disk_1.openFile(pathOrBufferOrDisk, 'r'), (fd) => __awaiter(this, void 0, void 0, function* () {
                return yield fn(new file_disk_1.FileDisk(fd), arg);
            }));
        }
        else if (Buffer.isBuffer(pathOrBufferOrDisk)) {
            return yield fn(new file_disk_1.BufferDisk(pathOrBufferOrDisk), arg);
        }
        else {
            return yield fn(pathOrBufferOrDisk, arg);
        }
    });
}
/**
 * @summary Get information from a partition
 * @public
 * @function
 *
 * @param {String|Buffer|filedisk.Disk} image - image path or buffer or filedisk.Disk instance
 * @param {Object} number - partition number
 *
 * @returns {Promise<Object>} partition information
 *
 * @example
 * partitioninfo.get('foo/bar.img', 5)
 * .then (information) ->
 * 	console.log(information.offset)
 * 	console.log(information.size)
 * 	console.log(information.type)
 * 	console.log(information.index)
 */
function get(disk, partitionNumber) {
    return __awaiter(this, void 0, void 0, function* () {
        return yield callWithDisk(getPartition, disk, partitionNumber);
    });
}
exports.get = get;
/**
 * @summary Read all partition tables from a disk image recursively.
 * @public
 * @function
 *
 * @description `getPartitions()` returns an Array.
 * `getPartitions(image)[N - 1]` may not be equal to `get(image, N)`
 * For example on a disk with no primary partitions and one extended partition
 * containing a logical one, `getPartitions(image)` would return an array of 2 partitions
 * (the extended then the logical one), `get(image, 1)` would return the extended
 * partition and `get(image, 5)` would return the logical partition. All other
 * numbers would throw an error.
 * Partition numbers for `get(image, N)` are like Linux's `/dev/sdaN`.
 *
 * The array returned by `getPartitions()` contains primary (or extended) partitions
 * first then the logical ones. This is true even if the extended partition is not the
 * last one of the disk image. Order will always be 1, [2, 3, 4, 5, 6, 7] even if
 * the logical partitions 5, 6 and 7 are physically contained in partiton 1, 2 or 3.
 *
 * @param {String|Buffer|filedisk.Disk} image - image path or buffer or filedisk.Disk instance
 * @param {Object} options
 * @param {Number} [options.offset=0] - where the first partition table will be read from, in bytes
 * @param {Boolean} [options.includeExtended=true] - whether to include extended partitions or not (only for MBR partition tables)
 * @param {Boolean} [options.getLogical=true] - whether to include logical partitions or not (only for MBR partition tables)
 *
 * @throws {Error} if there is no such partition
 *
 * @returns {Promise<Object>} partitions information
 *
 * @example
 * partitioninfo.getPartitions('foo/bar.img')
 * .then (information) ->
 * 	console.log(information.type)
 * 	for partition in information.partitions
 * 		console.log(partition.offset)
 * 		console.log(partition.size)
 * 		console.log(partition.type)
 * 		console.log(partition.index)
 */
function getPartitions(disk, { offset = 0, includeExtended = true, getLogical = true, } = {
    offset: 0,
    includeExtended: true,
    getLogical: true,
}) {
    return __awaiter(this, void 0, void 0, function* () {
        return yield callWithDisk(getDiskPartitions, disk, {
            offset,
            includeExtended,
            getLogical,
        });
    });
}
exports.getPartitions = getPartitions;
//# sourceMappingURL=partitioninfo.js.map