export class PicoError extends Error {
  code: number;

  static Internal = 0x00;
  static TooManyStores = 0x01;
  static DataTooLarge = 0x02;
  static InvalidName = 0x03;
  static SubscriptionUnavailable = 0x04;
  static Forbidden = 0x05;
  static RateLimited = 0x06;
  static StoreDeleted = 0x07;
  static VersionMismatch = 0x08;
  static StoreNotFound = 0x09;
  static InvalidRange = 0x0a;
  static SpliceConflict = 0x0b;

  constructor(code: number, message: string) {
    super(message);
    this.name = "PicoError";
    this.code = code;
  }
}
