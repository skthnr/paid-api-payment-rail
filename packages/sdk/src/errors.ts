/**
 * Typed SDK errors.
 *
 * Every failure the SDK raises carries a stable `code`, so callers branch on
 * the code instead of matching message text. Wire-format and transport
 * failures are never swallowed: `PorticoClient.pay()` either returns a settled
 * payment or throws.
 */

import type { SettlementResponse } from './types.js';

export type PorticoErrorCode =
  | 'invalid_client_config'
  | 'invalid_payment_options'
  | 'invalid_delegate_options'
  | 'payment_request_failed'
  | 'payment_required_missing'
  | 'payment_accept_mismatch'
  | 'payment_rejected'
  | 'payment_settlement_missing'
  | 'payment_settlement_failed'
  | 'quote_request_failed'
  | 'supported_request_failed'
  | 'delegate_encoding_failed'
  | 'contract_view_failed';

export interface PorticoErrorOptions {
  cause?: unknown;
}

/** Base class for every typed SDK error. */
export class PorticoError extends Error {
  public readonly code: PorticoErrorCode;

  public constructor(code: PorticoErrorCode, message: string, options: PorticoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid `PorticoClient` or `RevenueSplitClient` construction options. */
export class ClientConfigError extends PorticoError {
  public constructor(message: string, options: PorticoErrorOptions = {}) {
    super('invalid_client_config', message, options);
  }
}

/** Invalid arguments passed to `PorticoClient.pay()`. */
export class PaymentOptionsError extends PorticoError {
  public constructor(message: string, options: PorticoErrorOptions = {}) {
    super('invalid_payment_options', message, options);
  }
}

/** Invalid arguments passed to a meta-transaction builder. */
export class DelegateOptionsError extends PorticoError {
  public constructor(message: string, options: PorticoErrorOptions = {}) {
    super('invalid_delegate_options', message, options);
  }
}

/** The HTTP request itself failed before a response was received. */
export class PaymentRequestError extends PorticoError {
  public constructor(message: string, options: PorticoErrorOptions = {}) {
    super('payment_request_failed', message, options);
  }
}

/** The unpaid request did not answer with a usable HTTP 402 requirement. */
export class PaymentRequirementError extends PorticoError {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super('payment_required_missing', message);
    this.status = status;
  }
}

/** `accepts[0]` does not match the client configuration or the requested amount. */
export class PaymentAcceptError extends PorticoError {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super('payment_accept_mismatch', message);
    this.field = field;
  }
}

/** The paid retry was rejected (non-2xx status). */
export class PaymentRejectedError extends PorticoError {
  public readonly status: number;
  public readonly settlement: SettlementResponse | null;
  public readonly body: string | null;

  public constructor(
    message: string,
    details: { status: number; settlement?: SettlementResponse | null; body?: string | null }
  ) {
    super('payment_rejected', message);
    this.status = details.status;
    this.settlement = details.settlement ?? null;
    this.body = details.body ?? null;
  }
}

/** A successful HTTP response carried no `PAYMENT-RESPONSE` settlement. */
export class PaymentSettlementMissingError extends PorticoError {
  public readonly status: number;
  public readonly body: string | null;

  public constructor(message: string, details: { status: number; body?: string | null }) {
    super('payment_settlement_missing', message);
    this.status = details.status;
    this.body = details.body ?? null;
  }
}

/** The facilitator reported `success:false` or settled on another network. */
export class PaymentSettlementError extends PorticoError {
  public readonly settlement: SettlementResponse;

  public constructor(message: string, settlement: SettlementResponse) {
    super('payment_settlement_failed', message);
    this.settlement = settlement;
  }
}

/** `PorticoClient.quote()` did not receive a valid 402 requirement. */
export class QuoteRequestError extends PorticoError {
  public readonly status: number | null;
  public readonly body: string | null;

  public constructor(
    message: string,
    details: { status?: number | null; body?: string | null; cause?: unknown } = {}
  ) {
    super('quote_request_failed', message, { cause: details.cause });
    this.status = details.status ?? null;
    this.body = details.body ?? null;
  }
}

/** `PorticoClient.supported()` returned a non-2xx or malformed document. */
export class SupportedRequestError extends PorticoError {
  public readonly status: number | null;
  public readonly body: string | null;

  public constructor(
    message: string,
    details: { status?: number | null; body?: string | null; cause?: unknown } = {}
  ) {
    super('supported_request_failed', message, { cause: details.cause });
    this.status = details.status ?? null;
    this.body = details.body ?? null;
  }
}

/** A signed delegate could not be encoded to or decoded from canonical base64. */
export class DelegateEncodingError extends PorticoError {
  public constructor(message: string, options: PorticoErrorOptions = {}) {
    super('delegate_encoding_failed', message, options);
  }
}

/** A contract view call or its JSON payload was invalid. */
export class ContractViewError extends PorticoError {
  public readonly method: string;

  public constructor(method: string, message: string, options: PorticoErrorOptions = {}) {
    super('contract_view_failed', message, options);
    this.method = method;
  }
}
