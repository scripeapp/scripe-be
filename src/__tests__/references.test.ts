import {
  createTransactionReference,
  REFERENCE_TYPES,
  type TransactionReferenceType,
} from "../utils/references";

describe("createTransactionReference", () => {
  it("returns HLQ-<TYPE>-<8 random chars>", () => {
    const ref = createTransactionReference(REFERENCE_TYPES.WITHDRAWAL);
    expect(ref).toMatch(/^HLQ-WDR-[A-Z2-9]{8}$/);
  });

  it.each(Object.entries(REFERENCE_TYPES))(
    "uses the %s type code",
    (_, typeCode) => {
      expect(createTransactionReference(typeCode as TransactionReferenceType)).toMatch(
        new RegExp(`^HLQ-${typeCode}-[A-Z2-9]{8}$`),
      );
    },
  );

  it("returns unique references", () => {
    const refs = new Set(
      Array.from({ length: 1000 }, () =>
        createTransactionReference(REFERENCE_TYPES.EVENT_TICKET),
      ),
    );
    expect(refs.size).toBe(1000);
  });

  it("rejects unknown type codes", () => {
    expect(() =>
      createTransactionReference("EVENT" as TransactionReferenceType),
    ).toThrow("Invalid reference type");
  });
});