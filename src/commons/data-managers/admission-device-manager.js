const AdmissionDeviceModel = require("./models/admissionDeviceModel");

/**
 * Data manager of the admission devices (German "Einlassgerät"). Every
 * read names the tenant; the token hash never leaves the manager but for
 * the authentication (`getDeviceForAuthentication`).
 */
class AdmissionDeviceManager {
  /**
   * @param {Object} device The fields of `admissionDeviceSchema`
   * @returns {Promise<Object>} The stored device
   */
  static async createDevice(device) {
    const doc = await AdmissionDeviceModel.create(device);
    return doc.toObject();
  }

  /**
   * @param {string} tenantId
   * @param {string} id
   * @returns {Promise<Object|null>} The device, with its token hash
   */
  static async getDeviceForAuthentication(tenantId, id) {
    return AdmissionDeviceModel.findOne({ tenantId, id }).lean();
  }

  /**
   * @param {string} tenantId
   * @param {string} id
   * @returns {Promise<Object|null>} The device, without its token hash
   */
  static async getDevice(tenantId, id) {
    return AdmissionDeviceModel.findOne(
      { tenantId, id },
      { tokenHash: 0, _id: 0, __v: 0 },
    ).lean();
  }

  /**
   * @param {string} tenantId
   * @param {{ facilityId?: string }} [filters]
   * @returns {Promise<Object[]>} The devices, without their token hashes
   */
  static async getDevices(tenantId, filters = {}) {
    const condition = { tenantId };
    if (typeof filters.facilityId === "string" && filters.facilityId) {
      condition.facilityId = filters.facilityId;
    }
    return AdmissionDeviceModel.find(condition, {
      tokenHash: 0,
      _id: 0,
      __v: 0,
    })
      .sort({ label: 1 })
      .lean();
  }

  /**
   * @param {string} tenantId
   * @param {string} id
   * @param {Object} set
   * @returns {Promise<Object|null>} The device as written, without its token
   *   hash
   */
  static async updateDevice(tenantId, id, set) {
    return AdmissionDeviceModel.findOneAndUpdate(
      { tenantId, id },
      { $set: { ...set, timeUpdated: Date.now() } },
      { new: true, projection: { tokenHash: 0, _id: 0, __v: 0 } },
    ).lean();
  }

  /**
   * Notes that a device was seen, at most once per `minIntervalMs`.
   *
   * @param {string} tenantId
   * @param {string} id
   * @param {number} at
   * @param {number} minIntervalMs
   * @returns {Promise<void>}
   */
  static async touchDevice(tenantId, id, at, minIntervalMs) {
    await AdmissionDeviceModel.updateOne(
      {
        tenantId,
        id,
        $or: [
          { lastSeenAt: null },
          { lastSeenAt: { $lt: at - minIntervalMs } },
        ],
      },
      { $set: { lastSeenAt: at } },
    );
  }
}

module.exports = AdmissionDeviceManager;
