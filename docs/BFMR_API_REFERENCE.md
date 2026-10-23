# BFMR API v2 — readable reference

**Prepared:** 23 October 2026  
**Base URL shown in the source:** `https://api.bfmr.com`  
**Source:** [bfmr_api_spec.txt](bfmr_api_spec.txt), repository revision
[`6399b69`](https://github.com/z0ned/BFMR-Automation-v2/commit/6399b69).

This document reformats the supplied specification for people reading or
implementing an integration. It preserves parameter names, limits, status codes,
response keys and sample value types. Method/body/example conflicts are called
out where they occur and collected at the end. No API calls were made to verify
provider behavior. Descriptions and examples do not establish which operations
the BFMR automation project currently implements or authorizes.

## Endpoint directory

| Area | Operation | Documented method and path |
| --- | --- | --- |
| Deals | [Active Deals List](#active-deals) | `GET /api/v2/deals` |
| Deals | [Active Reservation List](#active-reservations) | `GET /api/v2/deal/reservations/active` |
| Deals | [Deal Details](#deal-details) | `GET /api/v2/deals/{slug}` |
| Insurance | [File for Insurance](#file-insurance) | `POST /api/v2/insurance/file` |
| Insurance | [Get Insured Shipment Details](#insurance-details) | `GET /api/v2/insurance/shipments/{tracking_number}` |
| Insurance | [Void insurance](#void-insurance) | `POST /api/v2/insurance/void` |
| Insurance | [Get insured shipments](#insured-shipments) | `GET /api/v2/insurance/shipments` |
| My Tracker | [Get My Tracker Data](#get-tracker) | `GET /api/v2/my-tracker` |
| My Tracker | [Make Updates in My Tracker](#update-tracker) | `POST /api/v2/my-tracker` |
| My Tracker | [Cancel Purchased](#cancel-purchased) | `POST /api/v2/my-tracker/purchase/cancel` |
| My Tracker | [Cancel Reserved](#cancel-reserved) | `POST /api/v2/my-tracker/reservation/cancel` |
| Lookups | [Active Retailers List](#retailers) | `GET /api/v2/look-ups/retailers` |

## Authentication and conventions

Send these headers with requests:

| Header | Type | Required | Description |
| --- | --- | --- | --- |
| `API-KEY` | string | Yes | Your API key. |
| `API-SECRET` | string | Yes | Your API secret. |

The source explicitly lists both headers on every operation except Void
Insurance, whose request example includes them. That omission is flagged below.
Keep actual credentials private; all examples here use placeholders.

Responses are documented as `application/json`. The source declares `message`
as `any` for Deals, My Tracker and Lookups; Insurance declares it as `string`.
Sample messages are strings throughout. A listed message is documented wording,
not a guarantee that every response has exactly that text.

Query parameters are not explicitly marked required in the source. Body and
path fields marked required below follow the explicit source declarations;
`{slug}` is also needed to construct the documented URL, despite its source
classification as a query parameter. Unspecified defaults and limits are not
inferred. JSON examples are source samples with indentation added; placeholder
zeros, dates and strings do not prove valid real values, units or date formats.

### Common error messages

| HTTP status | Documented message | Scope |
| --- | --- | --- |
| `401` | `API-KEY or API-SECRET incorrect` | All operations. |
| `429` | `Too Many Requests` | Deals, My Tracker and Lookups responses list it. Insurance does not list it. |

No rate-limit quota, reset interval, retry policy, idempotency key or general
error envelope is specified. Do not infer that unlisted errors cannot occur.

### Read-only request example

```bash
curl --request GET 'https://api.bfmr.com/api/v2/my-tracker' \
  --header 'API-KEY: YOUR-API-KEY' \
  --header 'API-SECRET: YOUR-API-SECRET'
```

<a id="active-deals"></a>

## Active Deals List

**`GET /api/v2/deals`**

Get all active deals.

### Query parameters

| Parameter | Type | Default / allowed values | Description |
| --- | --- | --- | --- |
| `page_size` | integer (int32) | 1–50 | Items per page. |
| `page_no` | integer (int32) | Not specified | Page number. |
| `retailer` | string | Not specified | Comma-separated retailer slugs. |
| `retail_type` | string | Examples: `above`, `full`, `below` | Comma-separated retail types; the source does not declare an exhaustive enum. |
| `exclusive_deals_only` | string | Default `"0"`; `"0"` or `"1"` | Set `"1"` to retrieve exclusive deals. |
| `in_stock` | string | Default `"0"`; `"0"` or `"1"` | Set `"1"` to retrieve in-stock deals. |

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Deal Found.` | `deals`: object. |
| `401` | Common unauthorized message | — |
| `429` | Common rate-limit message | — |

**Source shape:** although this is a list operation, `deals` is declared and
sampled as one object, not an array. Pagination metadata is not shown.

### Success response sample

```json
{
  "message": "Deal Found.",
  "deals": {
    "deal_id": "string",
    "deal_code": "string",
    "retail_price": 19.99,
    "title": "string",
    "slug": "string",
    "closing_at": "string",
    "is_reservation_closed": true,
    "retailers": "string",
    "retail_type": "string",
    "payout_price": 19.99,
    "deal_information": "string",
    "is_bundle": true,
    "is_exclusive_deal": true,
    "items": [
      {
        "id": "string",
        "name": "string",
        "color": "string",
        "model": "string",
        "upc": "string",
        "category": "string",
        "retailer_links": [
          {
            "retailer": "string",
            "identifier_id": "string",
            "url": "string"
          }
        ]
      }
    ]
  }
}
```

<a id="active-reservations"></a>

## Active Reservation List

**`GET /api/v2/deal/reservations/active`**

Get your active reservations.

No query or body parameters are documented.

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Active Reservation List.` | `reservation_list`: array of objects. |
| `401` | Common unauthorized message | — |
| `404` | `No reservations available` | — |
| `429` | Common rate-limit message | — |

**Method conflict:** the endpoint heading says `GET`, but its cURL example uses
`--request POST`. This reference displays the heading's method; the supported
method remains unresolved by the supplied text. No pagination contract is given.

### Success response sample

```json
{
  "message": "Active Reservation List.",
  "reservation_list": [
    {
      "item": [
        {
          "item_id": "string",
          "item_name": "string",
          "model_number": "string",
          "upcs": {},
          "color_name": "string",
          "retailer_links": [
            {
              "retailer": "string",
              "identifier_id": "string",
              "url": "string"
            }
          ]
        }
      ],
      "deal_id": "string",
      "reserve_id": "string",
      "reserved_quantity": 10,
      "remaining_quota": 10,
      "reserved_at": "string",
      "expiry_after": "string"
    }
  ]
}
```

<a id="deal-details"></a>

## Deal Details

**`GET /api/v2/deals/{slug}`**

Get the details of a deal.

### URL parameter

| Parameter | Type | Description |
| --- | --- | --- |
| `slug` | string | Deal slug obtained from the active-deal list. Substitute it in `{slug}`. |

**Classification conflict:** the source lists `slug` under query parameters,
but its route and request example place it in the URL path. The source cURL
example also puts a `--header` line before `curl`; the normalized URL is shown
in the heading above rather than reproducing that broken shell ordering.

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Deal Found.` | `deal`: object. |
| `401` | Common unauthorized message | — |
| `404` | `Deal is not available` | — |
| `429` | Common rate-limit message | — |

Unlike the list sample, the detail sample shows `items[].upc` as an array and
includes `items[].tracking_deadline`. The list sample also includes
`is_reservation_closed`, which the detail sample does not show.

### Success response sample

```json
{
  "message": "Deal Found.",
  "deal": {
    "deal_id": "string",
    "deal_code": "string",
    "retail_price": 19.99,
    "title": "string",
    "slug": "string",
    "closing_at": "string",
    "retailers": "string",
    "retail_type": "string",
    "payout_price": 19.99,
    "deal_information": "string",
    "is_bundle": true,
    "is_exclusive_deal": true,
    "items": [
      {
        "id": "string",
        "name": "string",
        "color": "string",
        "model": "string",
        "upc": [
          "string"
        ],
        "category": "string",
        "retailer_links": [
          {
            "retailer": "string",
            "identifier_id": "string",
            "url": "string"
          }
        ],
        "tracking_deadline": "string"
      }
    ]
  }
}
```

<a id="file-insurance"></a>

## File for Insurance

**`POST /api/v2/insurance/file`**

File insurance for a shipment. Supplied name/address fields also update the account profile.

### Request body

**Declared content type:** `application/x-www-form-urlencoded`.

| Field | Type | Required / fallback | Rules |
| --- | --- | --- | --- |
| `tracking_number` | string | Required | Shipment tracking number. |
| `package_value` | number (float) | Optional | If omitted, calculated from shipment items. Currency/precision are not specified. |
| `first_name` | string | Optional if saved on profile | Top-level field, not under `address`. If absent from request and profile, error names the missing field. |
| `last_name` | string | Optional if saved on profile | Same fallback as first name. |
| `address[address_1]` | string | Optional if saved on profile | 7–300 characters. Missing from both sources causes a field-specific error. |
| `address[address_2]` | string | Always optional | Address line 2. |
| `address[city]` | string | Optional | Profile fallback; maximum 255 characters. Field prose says blank on both request/profile does **not** fail. |
| `address[state]` | string | Optional if saved on profile | ISO 3166-2 subdivision suffix, e.g. `NH`, not `US-NH`. Must belong to the resolved submitted/profile country. |
| `address[country]` | string | Optional if saved on profile | ISO 3166-1 alpha-3, e.g. `USA`, not `US`. |
| `address[zip]` | string | Optional if saved on profile | 5–10 characters, digits and hyphens only. Examples: `03051`, `03051-4905`. |

Each name/address field is independently optional in the request. Omitted fields
fall back to saved profile values; required missing resolved values cause a
field-specific error. You can supply just one field to change it.

> **Persistent profile changes:** supplying `first_name`, `last_name` or any
> `address[...]` field also saves that change to the account profile. It is not
> restricted to this insurance filing.

**Source conflicts:** the sample uses cURL `--form` (multipart form data), unlike
the declared URL-encoded body. Sample comments say a missing city can produce
`City is required.`, while the city's field definition says it may remain blank.
Both require provider clarification. The source also gives
`Address Line 1 is required.` as a missing-field error example.

### Responses

| Status | Message / meaning |
| --- | --- |
| `200` | `Shipment insurance filed successfully` |
| `400` | Invalid input; example: `The shipment isn't eligible for insurance.` Missing-field errors are also described. |
| `401` | Common unauthorized message. |
| `404` | `Shipment not found` |

### Success response sample

```json
{
  "message": "Shipment insurance filed successfully"
}
```

<a id="insurance-details"></a>

## Get Insured Shipment Details

**`GET /api/v2/insurance/shipments/{tracking_number}`**

Get insurance and related item details for a shipment.

### Path parameter

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tracking_number` | string | Yes | Shipment tracking number. |

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Shipment details retrieved successfully` | `insurance`: object containing `shipment`. |
| `401` | Common unauthorized message | — |
| `404` | `Insurance not found` | — |

The response sample uses the placeholder `"string"` for `message` rather than
the success message listed above. Status values and monetary units are not defined.

### Success response sample

```json
{
  "message": "string",
  "insurance": {
    "shipment": {
      "tracking_number": "string",
      "package_cost": 0,
      "insured_amount": 0,
      "cert_no": "string",
      "cert_link": "string",
      "claim_no": "string",
      "policy_no": "string",
      "status": "string",
      "items": [
        {
          "item_id": 0,
          "name": "string",
          "qty": 0,
          "price": 0
        }
      ]
    }
  }
}
```

<a id="void-insurance"></a>

## Void insurance

**`POST /api/v2/insurance/void`**

Submit a request to void shipment insurance. Success means the request was submitted for review.

### Request body

**Declared content type:** `application/x-www-form-urlencoded`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tracking_number` | string | Yes | Shipment whose insurance should be voided. |

The example uses cURL `--form` instead of the declared URL-encoded body.
Authentication headers appear in that example but are omitted from this
operation's parameter listing.

### Responses

| Status | Message / meaning |
| --- | --- |
| `200` | `Void request submitted successfully. We'll notify you once it's reviewed.` |
| `400` | Validation error or insurance not found; example: `Insurance not found against the shipment`. |
| `401` | Common unauthorized message. |

A successful submission is not confirmation that insurance has already been
voided. The sample message below is a placeholder.

### Success response sample

```json
{
  "message": "string"
}
```

<a id="insured-shipments"></a>

## Get insured shipments

**`GET /api/v2/insurance/shipments`**

List insured shipments with filtering, pagination and sorting.

### Query parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `page` | integer | `1` | Page number. |
| `per_page` | integer | `20` | Items per page; maximum not specified. |
| `sort_by` | string | `created_at` | Sort field; complete allowed set not specified. |
| `sort_order` | string | `desc` | `asc` or `desc`. |
| `tracking_numbers` | string | Not specified | Comma-separated shipment tracking numbers. |

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `List of insured shipments` | `insurance`: object; `paging`: object. |
| `401` | Common unauthorized message | — |

The sample uses `"string"` for `message`. Its paging keys include `perPage`
(camel case), unlike the request parameter `per_page`. Follow the sample's
spelling; meanings/units beyond the supplied labels are not specified.

### Success response sample

```json
{
  "message": "string",
  "insurance": {
    "shipments": [
      {
        "tracking_number": "string",
        "date": "2019-08-24T14:15:22Z",
        "package_value": 0,
        "cost_of_insurance": 0,
        "certificate_number": "string",
        "certificate_link": "string",
        "notes": "string"
      }
    ]
  },
  "paging": {
    "current_page": 0,
    "from": 0,
    "last_page": 0,
    "to": 0,
    "total": 0,
    "perPage": 0,
    "pages": 0,
    "first": 0,
    "last": 0,
    "prev": "string",
    "next": "string"
  }
}
```

<a id="get-tracker"></a>

## Get My Tracker Data

**`GET /api/v2/my-tracker`**

Read My Tracker records using filters, search and sorting.

### Search change effective 20 November 2026

Before **20 November 2026**, `search` matches parts of item names, model numbers,
tracking numbers, order numbers or statuses. Starting that date it matches only
**item names and model numbers**. The source recommends switching now to:

- `orders[]` for complete order numbers.
- `trackings[]` for complete tracking numbers.
- `status` for statuses, including comma-separated selections.

### Query parameters

| Parameter | Type | Default / limits | Description |
| --- | --- | --- | --- |
| `page_size` | integer (int32) | 1–1,000 | Items per page. |
| `page_no` | integer (int32) | Not specified | Page number. |
| `order_by` | string | Enum below | Field to order by. |
| `order` | string | `asc`, `desc` | Sort order. |
| `search` | string | Not specified | Search term; see dated behavior change above. |
| `orders[]` | array of strings | Maximum 100 values | Whole submitted order number, including dashes; case-insensitive. Brackets required even for one value; repeat the parameter for multiple values. |
| `trackings[]` | array of strings | Maximum 100 values | Whole shipment tracking number; case-insensitive. Brackets required even for one value; repeat for multiple values. |
| `start_date` | string (date) | Source default: `2023-11-03` | Start of date filter. |
| `end_date` | string (date) | Source default: `2023-11-03` | End of date filter. |
| `quick_filter` | string | Enum below | Filter by tab. Explicit `status` filters take precedence; then quick filter is not functional. |
| `insurance_status` | string | `not_eligible`, `not_insured`, `insured` | Insurance-status filter. |
| `status` | string | Enum below | Comma-separated statuses; use instead of search for status matching. |

The fixed 2023 date defaults are reproduced from the supplied text; they are not
interpreted as today's date. The source does not explain which event date the
range filters, its timezone, boundary inclusivity or behavior when omitted.

**`order_by` values:** `status`, `qty`, `retail_price`, `qty_received`,
`amount_paid`, `reserved_at`, `sub_total`, `date_processed`, `date_paid`.

**`quick_filter` values:** `closed`, `all`, `action_needed`, `pending`, `paid`.

**`status` values:** `purchased`, `reserved`, `return`, `payment_error`, `shipped`,
`processed`, `set_aside`, `paid`, `cancelled`, `returned`, `closed`, `deadline`,
`pkg_received`.

For multiple orders, repeat `orders[]=EXAMPLE-ORDER-1&orders[]=EXAMPLE-ORDER-2`;
for multiple trackings, repeat
`trackings[]=EXAMPLE-TRACKING-1&trackings[]=EXAMPLE-TRACKING-2`.
These illustrate parameter structure; the values must be real whole identifiers.
The combination logic between different filter types is not specified.

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Tracker.` | `my_tracker`: array of objects. |
| `401` | Common unauthorized message | — |
| `404` | `Record not found` | — |
| `429` | Common rate-limit message | — |

The source does not show tracker pagination metadata. Sample dates are a mixture
of numeric zeros and strings; `status` and `deal_id` are numeric sample values,
although filters/other operations use strings. No mapping, epoch/timezone,
monetary unit or complete response-field schema is supplied. Preserve the sample
shape below without inferring those contracts.

### Success response sample

```json
{
  "message": "Tracker.",
  "my_tracker": [
    {
      "reserve_id": "string",
      "purchase_id": "string",
      "shipment_id": "string",
      "qty": 0,
      "amount_paid": 0,
      "deal_id": 0,
      "deal_title": "string",
      "item_id": "string",
      "item_model_number": "string",
      "order_date": 0,
      "order_deadline": 0,
      "qty_received": "string",
      "reserved_at": 0,
      "date_processed": 0,
      "date_paid": 0,
      "retail_price": 0,
      "payout_price": 0,
      "status": 0,
      "total_payout": 0,
      "tracking_deadline": "string",
      "deal_type": "string",
      "tracking_status": "string",
      "missed_deadline": true,
      "insurance_status": "string",
      "note": "string",
      "retailer_links": [
        {
          "retailer": "string",
          "identifier_id": "string",
          "url": "string"
        }
      ],
      "issue_with_item": [
        {
          "accepted_items": [
            {
              "name": "string",
              "status": "string"
            }
          ],
          "rejected_items": [
            {
              "name": "string",
              "status": "string",
              "issue_with_reason": [
                "string"
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

<a id="update-tracker"></a>

## Make Updates in My Tracker

**`POST /api/v2/my-tracker`**

Update reservations or create/update purchases and shipments.

### Request body

**Declared content type:** `application/json`.

| Field | Type | Required | Limit |
| --- | --- | --- | --- |
| `tracker_data` | array of objects | Yes | Maximum 500 objects per request. |

Each sample object contains `reserve_id`, `purchase_id`, `shipment_id`, `qty`,
`order_no`, and `tracking_number`. The operation-specific rules are below.
The source also labels the request “Array of reservation IDs,” but its detailed
field/sample show an object containing `tracker_data`; that label is ambiguous.

### Operation rules

| Action | Required fields | Fields the source says must be null | Notes |
| --- | --- | --- | --- |
| Update reservation | `reserve_id`, `qty` | `purchase_id`, `shipment_id` | Quantity can only be reduced. |
| Create purchase | `reserve_id`, `order_no`, `qty` | `purchase_id`, `shipment_id`, `tracking_number` | Source says process halts if a purchase is not active. Quantity can only be reduced from reservation quantity. |
| Update purchase | `reserve_id`, `purchase_id`, `order_no`, `qty` | `shipment_id`, `tracking_number` | Quantity can only be reduced. Source also says tracking and order numbers can be updated here, conflicting with null `tracking_number`. |
| Create shipment | `reserve_id`, `purchase_id`, `order_no`, `tracking_number`, `qty` | `shipment_id` | Process halts if a purchase is not active. Quantity can only be reduced from purchase or reservation quantity. |
| Update shipment | `reserve_id`, `purchase_id`, `shipment_id`, `tracking_number`, `qty` | Not specified | Source says tracking and order numbers can be updated here; `order_no` is not listed as required for this action. |

“Null” is the source's instruction; equivalence to omission or an empty string
is not defined. Minimum quantities and complete identifier/field types are not
specified independently of the illustrative payload. The “purchase is not
active” condition during **purchase creation** needs clarification.

### Request sample (source placeholders)

```json
{
  "tracker_data": [
    {
      "reserve_id": "string",
      "purchase_id": "string",
      "shipment_id": "string",
      "qty": 0,
      "order_no": "string",
      "tracking_number": "string"
    }
  ]
}
```

This generic sample does not satisfy every operation's null/required rules and
does not establish that `qty: 0` is accepted.

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Data updated successfully!` | `reservations_response`: object with valid/invalid item lists. |
| `401` | Common unauthorized message | — |
| `404` | `At least one of purchase_id, reserve_id, or shipment_id should not be empty.` | — |
| `429` | Common rate-limit message | — |

The source illustrates both `valid_items` and `invalid_items`, but their element
schema is not supplied. Atomicity, partial-success semantics and safe retry
behavior are not defined by the success message or example.

### Success response sample

```json
{
  "message": "Data updated successfully!",
  "reservations_response": {
    "valid_items": [
      {}
    ],
    "invalid_items": [
      {}
    ]
  }
}
```

<a id="cancel-purchased"></a>

## Cancel Purchased

**`POST /api/v2/my-tracker/purchase/cancel`**

Cancel items with the Purchased status.

### Request body

| Field | Required | Declared type / sample |
| --- | --- | --- |
| `purchase_id` | Yes | Source declares an array of objects, describes an array of purchase IDs, and samples an array of strings. |

**Encoding conflict:** the declared schema is
`application/x-www-form-urlencoded`, but the request sample sets
`Content-Type: application/json`. The sample also uses single quotes inside its
JSON, making it invalid JSON. Its intended structure, reformatted as valid JSON
for illustration only, is:

```json
{
  "purchase_id": ["EXAMPLE-PURCHASE-ID"]
}
```

The source omits the leading `/` in the route label; this document normalizes it
in the endpoint heading. Accepted body encoding/element types remain unresolved.

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Purchase cancelled successfully!` | `invalid_purchases`: array of any; invalid purchase IDs are reported here. |
| `401` | Common unauthorized message | — |
| `422` | `Not a Valid Purchase or already cancelled` | — |
| `429` | Common rate-limit message | — |

The sample uses `[null]` for invalid purchases; it does not establish a complete
per-item error schema or all-or-nothing batch behavior.

### Success response sample

```json
{
  "message": "Purchase cancelled successfully!",
  "invalid_purchases": [
    null
  ]
}
```

<a id="cancel-reserved"></a>

## Cancel Reserved

**`POST /api/v2/my-tracker/reservation/cancel`**

Cancel items with the Reserved status.

### Request body

| Field | Required | Declared type / sample |
| --- | --- | --- |
| `reserve_id` | Yes | Source declares an array of objects, describes an array of reservation IDs, and samples an array of strings. |

**Encoding/URL conflicts:** the schema says
`application/x-www-form-urlencoded`; the sample sets `application/json` and uses
invalid single-quoted JSON. It also targets the local development host
`http://api-v2.buyformeretail.local`, unlike the other public HTTPS examples.
The endpoint heading here uses the commonly shown public base URL and adds the
missing leading `/`; this normalization is not provider verification.
The intended JSON structure is illustrated below without resolving encoding:

```json
{
  "reserve_id": ["EXAMPLE-RESERVATION-ID"]
}
```

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Reservation cancelled successfully!` | `invalid_reservations`: array of any; invalid reservation IDs are reported here. |
| `401` | Common unauthorized message | — |
| `422` | `Not a Valid Reservation or reservation already cancelled` | — |
| `429` | Common rate-limit message | — |

The sample uses `[null]`; complete per-item and batch-success semantics are not
specified. This cancels existing Reserved items; it is not a reservation-creation
endpoint.

### Success response sample

```json
{
  "message": "Reservation cancelled successfully!",
  "invalid_reservations": [
    null
  ]
}
```

<a id="retailers"></a>

## Active Retailers List

**`GET /api/v2/look-ups/retailers`**

List retailers that may appear in a deal.

### Query parameters

| Parameter | Type | Limits / default | Description |
| --- | --- | --- | --- |
| `page_size` | integer (int32) | 1–1,000; no default specified | Items per page. |
| `page_no` | integer (int32) | Not specified | Page number. |

### Responses

| Status | Message | Additional fields |
| --- | --- | --- |
| `200` | `Active Retailers list.` | `retailers`: object. |
| `401` | Common unauthorized message | — |
| `429` | Common rate-limit message | — |

Although this is a list operation, `retailers` is declared/sampled as one object,
not an array. No paging metadata is shown. The returned `slug` is the identifier
used by the active-deals `retailer` query filter.

### Success response sample

```json
{
  "message": "Active Retailers list.",
  "retailers": {
    "name": "string",
    "slug": "string",
    "link": "string"
  }
}
```

## Source inconsistencies and integration questions

| Topic | What needs clarification |
| --- | --- |
| Active-reservation method | `GET` heading versus `POST` cURL example. |
| Deal slug | Query classification versus URL path placement. |
| List response shapes | Active deals and retailers are sampled as objects, not arrays. |
| Item UPCs | Deal-list `upc` is a string; detail `upc` is an array; reservation `upcs` is an object. |
| Insurance encoding | URL-encoded schema versus multipart `--form` examples for file/void. |
| Insurance city | Field definition permits blank, but sample commentary gives a missing-city error. |
| Void authentication | Header definitions omitted, although sample includes both credentials. |
| Tracker updates | Purchase-update null tracking field conflicts with tracking-update prose; purchase-creation active-purchase prerequisite is unclear. |
| Cancellation bodies | URL-encoded declaration versus JSON sample; object-array declaration versus string IDs; sample JSON quoting is invalid. |
| Reservation-cancel URL | Development HTTP host instead of the commonly shown public HTTPS base. |
| Pagination/completeness | Metadata absent for deals, active reservations, tracker and retailers; page numbering/defaults and completion signals are not fully defined. |
| Tracker defaults/types | Fixed 2023 date defaults, numeric status/deal/date samples, and missing mappings/date/monetary units. |
| Write outcomes | No idempotency, atomicity, partial-success contract or safe retry rules are supplied. |

The supplied text contains **no reservation-creation endpoint**. It documents
reads, tracker updates, cancellation and insurance operations. It does not
provide webhook contracts or a full status-transition model. Those omissions
should remain explicit rather than be filled with invented API behavior.
