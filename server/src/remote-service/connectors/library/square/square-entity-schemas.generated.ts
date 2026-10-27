// GENERATED FILE — do not edit by hand. Regenerate with server/scripts/generate-square-entity-schemas.mjs
// from https://github.com/square/connect-api-specification (api.json).

/** The Square-Version these shapes were generated from. Must equal SQUARE_CONNECTOR_API_VERSION. */
export const SQUARE_ENTITY_SCHEMAS_SQUARE_VERSION = '2026-09-16';

/** The Square objects whose schemas this file carries — Square's own object names. */
export type SquareObjectName =
  | 'Location'
  | 'Customer'
  | 'CatalogObject'
  | 'Order'
  | 'Payment'
  | 'PaymentRefund'
  | 'Invoice'
  | 'TeamMember'
  | 'Payout';

/**
 * One self-contained JSON Schema per Square object, keyed by Square's own object name. Deliberately
 * typed loosely (not `as const`): literal-typing this much JSON only slows the compiler down, and
 * consumers walk it as plain JSON Schema anyway.
 */
export const SQUARE_ENTITY_SCHEMAS_BY_SQUARE_OBJECT_NAME: Record<SquareObjectName, Record<string, unknown>> = {
  Location: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'A short generated string of letters and numbers that uniquely identifies this location instance.',
      },
      name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The name of the location.',
      },
      address: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address_line_1: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The first line of the address.',
              },
              address_line_2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The second line of the address, if any.',
              },
              address_line_3: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The third line of the address, if any.',
              },
              locality: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The city or town of the address.',
              },
              sublocality: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil region within the address's `locality`, if any.",
              },
              sublocality_2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil region within the address's `sublocality`, if any.",
              },
              sublocality_3: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil region within the address's `sublocality_2`, if any.",
              },
              administrative_district_level_1: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil entity within the address's country.",
              },
              administrative_district_level_2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil entity within the address's `administrative_district_level_1`.",
              },
              administrative_district_level_3: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil entity within the address's `administrative_district_level_2`, if any.",
              },
              postal_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The address's postal code.",
              },
              country: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The address's country, in the two-letter format of ISO 3166.",
              },
              first_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Optional first name when it's representing recipient.",
              },
              last_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Optional last name when it's representing recipient.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The physical address of the location.',
      },
      timezone: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The IANA time zone identifier for the time zone of the location.',
      },
      capabilities: {
        type: 'array',
        items: {
          type: 'string',
          description: 'The capabilities a location might have.',
        },
        description: 'The Square features that are enabled for the location.',
      },
      status: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The status of the location.',
      },
      created_at: {
        type: 'string',
        description: 'The time when the location was created, in RFC 3339 format.',
      },
      merchant_id: {
        type: 'string',
        description: 'The ID of the merchant that owns the location.',
      },
      country: {
        type: 'string',
        description: 'The country of the location, in the two-letter format of ISO 3166.',
      },
      language_code: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The language associated with the location, in BCP 47 format.',
      },
      currency: {
        type: 'string',
        description: 'The currency used for all transactions at this location, in ISO 4217 format.',
      },
      phone_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The phone number of the location.',
      },
      business_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The name of the location's overall business.",
      },
      type: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The type of the location.',
      },
      website_url: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The website URL of the location.',
      },
      business_hours: {
        anyOf: [
          {
            type: 'object',
            properties: {
              periods: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        day_of_week: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The day of the week for this time period.',
                        },
                        start_local_time: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The start time of a business hours period, specified in local time using partial-time RFC 3339 format.',
                        },
                        end_local_time: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The end time of a business hours period, specified in local time using partial-time RFC 3339 format.',
                        },
                      },
                      description: 'Represents a period of time during which a business location is open.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The list of time periods during which the business is open.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The hours of operation for the location.',
      },
      business_email: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The email address of the location.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The description of the location.',
      },
      twitter_username: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The Twitter username of the location without the '@' symbol.",
      },
      instagram_username: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The Instagram username of the location without the '@' symbol.",
      },
      facebook_url: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The Facebook profile URL of the location.',
      },
      coordinates: {
        anyOf: [
          {
            type: 'object',
            properties: {
              latitude: {
                anyOf: [
                  {
                    type: 'number',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The latitude of the coordinate expressed in degrees.',
              },
              longitude: {
                anyOf: [
                  {
                    type: 'number',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The longitude of the coordinate expressed in degrees.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The physical coordinates (latitude and longitude) of the location.',
      },
      logo_url: {
        type: 'string',
        description: 'The URL of the logo image for the location.',
      },
      pos_background_url: {
        type: 'string',
        description: 'The URL of the Point of Sale background image for the location.',
      },
      mcc: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A four-digit number that describes the kind of goods or services sold at the location.',
      },
      full_format_logo_url: {
        type: 'string',
        description: 'The URL of a full-format logo image for the location.',
      },
      tax_ids: {
        type: 'object',
        properties: {
          eu_vat: {
            type: 'string',
            description: 'The EU VAT number for this location.',
          },
          fr_siret: {
            type: 'string',
            description:
              "The SIRET (Système d'Identification du Répertoire des Entreprises et de leurs Etablissements) number is a 14-digit code issued by the French INSEE.",
          },
          fr_naf: {
            type: 'string',
            description:
              'The French government uses the NAF (Nomenclature des Activités Françaises) to display and track economic statistical data.',
          },
          es_nif: {
            type: 'string',
            description:
              'The NIF (Numero de Identificacion Fiscal) number is a nine-character tax identifier used in Spain.',
          },
          jp_qii: {
            type: 'string',
            description: 'The QII (Qualified Invoice Issuer) number is a 14-character tax identifier used in Japan.',
          },
        },
        description: 'The tax IDs for this location.',
      },
      custom_receipt_text: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The custom text that appears on receipts issued for this location.',
      },
      return_policy: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The return policy that appears on receipts issued for this location.',
      },
    },
    description: "Represents one of a business' locations.",
  },
  Customer: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'A unique Square-assigned ID for the customer profile.',
      },
      created_at: {
        type: 'string',
        description: 'The timestamp when the customer profile was created, in RFC 3339 format.',
      },
      updated_at: {
        type: 'string',
        description: 'The timestamp when the customer profile was last updated, in RFC 3339 format.',
      },
      given_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The given name (that is, the first name) associated with the customer profile.',
      },
      family_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The family name (that is, the last name) associated with the customer profile.',
      },
      nickname: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A nickname for the customer profile.',
      },
      company_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A business name associated with the customer profile.',
      },
      email_address: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The email address associated with the customer profile.',
      },
      address: {
        anyOf: [
          {
            type: 'object',
            properties: {
              address_line_1: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The first line of the address.',
              },
              address_line_2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The second line of the address, if any.',
              },
              address_line_3: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The third line of the address, if any.',
              },
              locality: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The city or town of the address.',
              },
              sublocality: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil region within the address's `locality`, if any.",
              },
              sublocality_2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil region within the address's `sublocality`, if any.",
              },
              sublocality_3: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil region within the address's `sublocality_2`, if any.",
              },
              administrative_district_level_1: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil entity within the address's country.",
              },
              administrative_district_level_2: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil entity within the address's `administrative_district_level_1`.",
              },
              administrative_district_level_3: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "A civil entity within the address's `administrative_district_level_2`, if any.",
              },
              postal_code: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The address's postal code.",
              },
              country: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The address's country, in the two-letter format of ISO 3166.",
              },
              first_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Optional first name when it's representing recipient.",
              },
              last_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Optional last name when it's representing recipient.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The physical address associated with the customer profile.',
      },
      phone_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The phone number associated with the customer profile.',
      },
      birthday: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The birthday associated with the customer profile, in `YYYY-MM-DD` format.',
      },
      reference_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An optional second ID used to associate the customer profile with an entity in another system.',
      },
      note: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A custom note associated with the customer profile.',
      },
      preferences: {
        anyOf: [
          {
            type: 'object',
            properties: {
              email_unsubscribed: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether the customer has unsubscribed from marketing campaign emails.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Represents general customer preferences.',
      },
      creation_source: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The method used to create the customer profile.',
      },
      group_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The IDs of customer groups the customer belongs to.',
      },
      segment_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The IDs of customer segments the customer belongs to.',
      },
      version: {
        type: 'integer',
        description: 'The Square-assigned version number of the customer profile.',
      },
      tax_ids: {
        anyOf: [
          {
            type: 'object',
            properties: {
              eu_vat: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The EU VAT identification number for the customer.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The tax ID associated with the customer profile.',
      },
    },
    description: 'Represents a Square customer profile in the Customer Directory of a Square seller.',
  },
  CatalogObject: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'The type of this object.',
      },
      id: {
        type: 'string',
        description: 'An identifier to reference this object in the catalog.',
      },
      updated_at: {
        type: 'string',
        description:
          'Last modification timestamp in RFC 3339 format, e.g., `"2016-08-15T23:59:33.123Z"` would indicate the UTC time (denoted by `Z`) of August 15, 2016 at 23:59:33 and 123 milliseconds.',
      },
      version: {
        type: 'integer',
        description: 'The version of the object.',
      },
      is_deleted: {
        anyOf: [
          {
            type: 'boolean',
          },
          {
            type: 'null',
          },
        ],
        description: 'If `true`, the object has been deleted from the database.',
      },
      custom_attribute_values: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                name: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The name of the custom attribute.',
                },
                string_value: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The string value of the custom attribute.',
                },
                custom_attribute_definition_id: {
                  type: 'string',
                  description: 'The id of the CatalogCustomAttributeDefinition this value belongs to.',
                },
                type: {
                  type: 'string',
                  description: 'A copy of type from the associated `CatalogCustomAttributeDefinition`.',
                },
                number_value: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Populated if `type` = `NUMBER`.',
                },
                boolean_value: {
                  anyOf: [
                    {
                      type: 'boolean',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A `true` or `false` value.',
                },
                selection_uid_values: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'One or more choices from `allowed_selections`.',
                },
                key: {
                  type: 'string',
                  description:
                    'If the associated `CatalogCustomAttributeDefinition` object is defined by another application, this key is prefixed by the defining application ID.',
                },
              },
              description: 'An instance of a custom attribute.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'A map (key-value pairs) of application-defined custom attribute values.',
      },
      catalog_v1_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                catalog_v1_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'The ID for an object used in the Square API V1, if the object ID differs from the Square API V2 object ID.',
                },
                location_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The ID of the `Location` this Connect V1 ID is associated with.',
                },
              },
              description:
                'A Square API V1 identifier of an item, including the object ID and its associated location ID.',
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          "The Connect v1 IDs for this object at each location where it is present, where they differ from the object's Connect V2 ID.",
      },
      present_at_all_locations: {
        anyOf: [
          {
            type: 'boolean',
          },
          {
            type: 'null',
          },
        ],
        description: 'Controls whether this object is present at all locations, including future locations.',
      },
      present_at_location_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Locations where the object is present, used when `present_at_all_locations` is false.',
      },
      absent_at_location_ids: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Locations where the object is not present, used when `present_at_all_locations` is true.',
      },
      item_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item's name.",
              },
              description: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item's description.",
              },
              abbreviation: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The text of the item's display label in the Square Point of Sale app.",
              },
              label_color: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The color of the item's display label in the Square Point of Sale app.",
              },
              is_taxable: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether the item is taxable (`true`) or non-taxable (`false`).',
              },
              category_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The ID of the item's category, if any.",
              },
              buyer_facing_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The override to a product name to display to users',
              },
              tax_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A set of IDs indicating the taxes enabled for this item.',
              },
              modifier_list_info: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        modifier_list_id: {
                          type: 'string',
                          description:
                            'The ID of the `CatalogModifierList` controlled by this `CatalogModifierListInfo`.',
                        },
                        modifier_overrides: {
                          anyOf: [
                            {
                              type: 'array',
                              items: {
                                type: 'object',
                                description:
                                  'Options to control how to override the default behavior of the specified modifier.',
                              },
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'A set of `CatalogModifierOverride` objects that override default modifier settings for this item.',
                        },
                        min_selected_modifiers: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The minimum number of modifiers that must be selected from this modifier list.',
                        },
                        max_selected_modifiers: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The maximum number of modifiers that can be selected.',
                        },
                        enabled: {
                          anyOf: [
                            {
                              type: 'boolean',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'If `true`, enable this `CatalogModifierList`.',
                        },
                        ordinal: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The position of this `CatalogItemModifierListInfo` object within the `modifier_list_info` list applied to a `CatalogItem` instance.',
                        },
                        allow_quantities: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Controls whether multiple quantities of the same modifier can be selected for this item.',
                        },
                        is_conversational: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Controls whether conversational mode is enabled for modifiers on this item.',
                        },
                        hidden_from_customer_override: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Controls whether all modifiers for this item are hidden from customer receipts.',
                        },
                      },
                      description: 'Controls how a modifier list is applied to a specific item.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A set of `CatalogItemModifierListInfo` objects representing the modifier lists that apply to this item, along with the overrides and min and max limits that are specific to this item.',
              },
              variations: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      description: 'The wrapper object for the catalog entries of a given object type.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A list of CatalogItemVariation objects for this item.',
              },
              product_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The product type of the item.',
              },
              skip_modifier_screen: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "If `false`, the Square Point of Sale app will present the `CatalogItem`'s details screen immediately, allowing the merchant to choose `CatalogModifier`s before adding the item to the cart.",
              },
              item_options: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        item_option_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The unique id of the item option, used to form the dimensions of the item option matrix in a specified order.',
                        },
                      },
                      description: 'An option that can be assigned to an item.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'List of item options IDs for this item.',
              },
              ecom_uri: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Deprecated.',
              },
              ecom_image_uris: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Deprecated.',
              },
              image_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The IDs of images associated with this `CatalogItem` instance.',
              },
              sort_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A name to sort the item by.',
              },
              categories: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: {
                          type: 'string',
                          description: "The ID of the object's category.",
                        },
                        ordinal: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The position of this object within the specified category.',
                        },
                      },
                      description:
                        'A category that can be assigned to an item or a parent category that can be assigned to another category.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The list of categories to which this item belongs.',
              },
              description_html: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item's description as expressed in valid HTML elements.",
              },
              description_plaintext: {
                type: 'string',
                description:
                  'A server-generated plaintext version of the `description_html` field, without formatting tags.',
              },
              kitchen_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  '(Optional) Name that the restaurant wants to display to their kitchen workers instead of the customer-facing name.',
              },
              channels: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A list of IDs representing channels, such as a Square Online site, where the item can be made visible or available.',
              },
              is_archived: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether this item is archived (`true`) or not (`false`).',
              },
              ecom_seo_data: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      page_title: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The SEO title used for the Square Online store.',
                      },
                      page_description: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The SEO description used for the Square Online store.',
                      },
                      permalink: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The SEO permalink used for the Square Online store.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The SEO data for a seller's Square Online store.",
              },
              food_and_beverage_details: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      calorie_count: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The calorie count (in the unit of kcal) for the `FOOD_AND_BEV` type of items.',
                      },
                      dietary_preferences: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description:
                                'Dietary preferences that can be assigned to an `FOOD_AND_BEV` item and its ingredients.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The dietary preferences for the `FOOD_AND_BEV` item.',
                      },
                      ingredients: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description: 'Describes the ingredient used in a `FOOD_AND_BEV` item.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The ingredients for the `FOOD_AND_BEV` type item.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The food and beverage-specific details for the `FOOD_AND_BEV` item.',
              },
              reporting_category: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description: "The ID of the object's category.",
                      },
                      ordinal: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The position of this object within the specified category.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item's reporting category.",
              },
              is_alcoholic: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether this item is alcoholic (`true`) or not (`false`).',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogItem`, set for CatalogObjects of type `ITEM`.',
      },
      category_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The category name.',
              },
              image_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The IDs of images associated with this `CatalogCategory` instance.',
              },
              category_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of the category.',
              },
              parent_category: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description: "The ID of the object's category.",
                      },
                      ordinal: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The position of this object within the specified category.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The parent category of this category instance.',
              },
              is_top_level: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Indicates whether a category is a top level category, which does not have any parent_category.',
              },
              channels: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A list of IDs representing channels, such as a Square Online site, where the category can be made visible.',
              },
              availability_period_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The IDs of the `CatalogAvailabilityPeriod` objects associated with the category.',
              },
              online_visibility: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "Indicates whether the category is visible (`true`) or hidden (`false`) on all of the seller's Square Online sites.",
              },
              root_category: {
                type: 'string',
                description: 'The top-level category in a category hierarchy.',
              },
              ecom_seo_data: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      page_title: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The SEO title used for the Square Online store.',
                      },
                      page_description: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The SEO description used for the Square Online store.',
                      },
                      permalink: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The SEO permalink used for the Square Online store.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The SEO data for a seller's Square Online store.",
              },
              path_to_root: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        category_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: "The category's ID.",
                        },
                        category_name: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: "The category's name.",
                        },
                      },
                      description: 'A node in the path from a retrieved category to its root node.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The path from the category to its root category.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogCategory`, set for CatalogObjects of type `CATEGORY`.',
      },
      item_variation_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              item_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the `CatalogItem` associated with this item variation.',
              },
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item variation's name.",
              },
              sku: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item variation's SKU, if any.",
              },
              upc: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The universal product code (UPC) of the item variation, if any.',
              },
              ordinal: {
                type: 'integer',
                description: 'The order in which this item variation should be displayed.',
              },
              pricing_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Indicates whether the item variation's price is fixed or determined at the time of sale.",
              },
              price_money: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of currency, in __ISO 4217 format__.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item variation's price, if fixed pricing is used.",
              },
              location_overrides: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        location_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The ID of the `Location`.',
                        },
                        price_money: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The price of the `CatalogItemVariation` at the given `Location`, or blank for variable pricing.',
                        },
                        pricing_type: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The pricing type (fixed or variable) for the `CatalogItemVariation` at the given `Location`.',
                        },
                        track_inventory: {
                          anyOf: [
                            {
                              type: 'boolean',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Indicates whether inventory tracking is active for the `CatalogItemVariation` at this `Location`.',
                        },
                        inventory_alert_type: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Indicates whether the `CatalogItemVariation` displays an alert when its inventory quantity is less than or equal to its `inventory_alert_threshold`.',
                        },
                        inventory_alert_threshold: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'If the inventory quantity for the variation is less than or equal to this value and `inventory_alert_type` is `LOW_QUANTITY`, the variation displays an alert in the merchant dashboard.',
                        },
                        sold_out: {
                          type: 'boolean',
                          description:
                            'Indicates whether the overridden item variation is sold out at the specified location.',
                        },
                        sold_out_valid_until: {
                          type: 'string',
                          description:
                            'The seller-assigned timestamp, of the RFC 3339 format, to indicate when this sold-out variation becomes available again at the specified location.',
                        },
                      },
                      description:
                        'Price and inventory alerting overrides for a `CatalogItemVariation` at a specific `Location`.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Per-location price and inventory overrides.',
              },
              track_inventory: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'If `true`, inventory tracking is active for the variation at all locations by default.',
              },
              inventory_alert_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Indicates whether the item variation displays an alert when its inventory quantity is less than or equal to its `inventory_alert_threshold`.',
              },
              inventory_alert_threshold: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If the inventory quantity for the variation is less than or equal to this value and `inventory_alert_type` is `LOW_QUANTITY`, the variation displays an alert in the merchant dashboard.',
              },
              user_data: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Arbitrary user metadata to associate with the item variation.',
              },
              service_duration: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If the `CatalogItem` that owns this item variation is of type `APPOINTMENTS_SERVICE`, then this is the duration of the service in milliseconds.',
              },
              available_for_booking: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If the `CatalogItem` that owns this item variation is of type `APPOINTMENTS_SERVICE`, a bool representing whether this service is available for booking.',
              },
              item_option_values: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        item_option_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The unique id of an item option.',
                        },
                        item_option_value_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The unique id of the selected value for the item option.',
                        },
                      },
                      description:
                        'A `CatalogItemOptionValue` links an item variation to an item option as an item option value.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'List of item option values associated with this item variation.',
              },
              measurement_unit_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'ID of the ‘CatalogMeasurementUnit’ that is used to measure the quantity sold of this item variation.',
              },
              sellable: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Whether this variation can be sold.',
              },
              stockable: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Whether stock is counted directly on this variation (TRUE) or only on its components (FALSE).',
              },
              image_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The IDs of images associated with this `CatalogItemVariation` instance.',
              },
              team_member_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Tokens of employees that can perform the service represented by this variation.',
              },
              stockable_conversion: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      stockable_item_variation_id: {
                        type: 'string',
                        description: 'References to the stockable CatalogItemVariation for this stock conversion.',
                      },
                      stockable_quantity: {
                        type: 'string',
                        description:
                          'The quantity of the stockable item variation (as identified by `stockable_item_variation_id`) equivalent to the non-stockable item variation quantity (as specified in `nonstockable_quantity`) as defi…',
                      },
                      nonstockable_quantity: {
                        type: 'string',
                        description:
                          'The converted equivalent quantity of the non-stockable CatalogItemVariation in its measurement unit.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The unit conversion rule, as prescribed by the CatalogStockConversion type, that describes how this non-stockable (i.e., sellable/receivable) item variation is converted to/from the stockable item va…',
              },
              kitchen_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  '(Optional) Name that the restaurant wants to display to their kitchen workers instead of the customer-facing name.',
              },
              vendor_information: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        vendor_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'ID of the Vendor linked to a default cost of this product.',
                        },
                        vendor_code: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: "Unique identifier of this product in the specified vendor's' inventory system.",
                        },
                        unit_cost_money: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The unit cost of the linked product, when purchased from the linked vendor.',
                        },
                      },
                      description: 'Information about the vendor of an item variation.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Details of the vendor this product is purchased from.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogItemVariation`, set for CatalogObjects of type `ITEM_VARIATION`.',
      },
      tax_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The tax's name.",
              },
              calculation_phase: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Whether the tax is calculated based on a payment's subtotal or total.",
              },
              inclusion_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Whether the tax is `ADDITIVE` or `INCLUSIVE`.',
              },
              percentage: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "The percentage of the tax in decimal form, using a `'.'` as the decimal separator and without a `'%'` sign.",
              },
              applies_to_custom_amounts: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If `true`, the fee applies to custom amounts entered into the Square Point of Sale app that are not associated with a particular `CatalogItem`.',
              },
              enabled: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A Boolean flag to indicate whether the tax is displayed as enabled (`true`) in the Square Point of Sale app or not (`false`).',
              },
              applies_to_product_set_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of a `CatalogProductSet` object.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogTax`, set for CatalogObjects of type `TAX`.',
      },
      discount_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The discount name.',
              },
              discount_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Indicates whether the discount is a fixed amount or percentage, or entered at the time of sale.',
              },
              percentage: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The percentage of the discount as a string representation of a decimal number, using a `.` as the decimal separator and without a `%` sign.',
              },
              amount_money: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of currency, in __ISO 4217 format__.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The amount of the discount.',
              },
              pin_required: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Indicates whether a mobile staff member needs to enter their PIN to apply the discount to a payment in the Square Point of Sale app.',
              },
              label_color: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The color of the discount display label in the Square Point of Sale app.',
              },
              modify_tax_basis: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether this discount should reduce the price used to calculate tax.',
              },
              maximum_amount_money: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of currency, in __ISO 4217 format__.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'For a percentage discount, the maximum absolute value of the discount.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogDiscount`, set for CatalogObjects of type `DISCOUNT`.',
      },
      modifier_list_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The name of the `CatalogModifierList` instance.',
              },
              ordinal: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The position of this `CatalogModifierList` within a list of `CatalogModifierList` instances.',
              },
              selection_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  '__Deprecated__: Indicates whether a single (`SINGLE`) modifier or multiple (`MULTIPLE`) modifiers can be selected.',
              },
              modifiers: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      description: 'The wrapper object for the catalog entries of a given object type.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A non-empty list of `CatalogModifier` objects to be included in the `CatalogModifierList`, for non text-based modifiers when the `modifier_type` attribute is `LIST`.',
              },
              image_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The IDs of images associated with this `CatalogModifierList` instance.',
              },
              allow_quantities: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'When `true`, allows multiple quantities of the same modifier to be selected.',
              },
              is_conversational: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'True if modifiers belonging to this list can be used conversationally.',
              },
              modifier_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of the modifier.',
              },
              max_length: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The maximum length, in Unicode points, of the text string of the text-based modifier as represented by this `CatalogModifierList` object with the `modifier_type` set to `TEXT`.',
              },
              text_required: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Whether the text string must be a non-empty string (`true`) or not (`false`) for a text-based modifier as represented by this `CatalogModifierList` object with the `modifier_type` set to `TEXT`.',
              },
              internal_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A note for internal use by the business.',
              },
              min_selected_modifiers: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The minimum number of modifiers that must be selected from this list.',
              },
              max_selected_modifiers: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The maximum number of modifiers that must be selected from this list.',
              },
              hidden_from_customer: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'If `true`, modifiers from this list are hidden from customer receipts.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogModifierList`, set for CatalogObjects of type `MODIFIER_LIST`.',
      },
      modifier_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The modifier name.',
              },
              price_money: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of currency, in __ISO 4217 format__.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The modifier price.',
              },
              on_by_default: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'When `true`, this modifier is selected by default when displaying the modifier list.',
              },
              ordinal: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Determines where this `CatalogModifier` appears in the `CatalogModifierList`.',
              },
              modifier_list_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the `CatalogModifierList` associated with this modifier.',
              },
              location_overrides: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        location_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The ID of the `Location` object representing the location.',
                        },
                        price_money: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The overridden price at the specified location.',
                        },
                        sold_out: {
                          type: 'boolean',
                          description: 'Indicates whether the modifier is sold out at the specified location or not.',
                        },
                      },
                      description:
                        'Location-specific overrides for specified properties of a `CatalogModifier` object.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Location-specific price overrides.',
              },
              kitchen_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  '(Optional) Name that the restaurant wants to display to their kitchen workers instead of the customer-facing name.',
              },
              image_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the image associated with this `CatalogModifier` instance.',
              },
              hidden_online: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'When `true`, this modifier is hidden from online ordering channels.',
              },
              child_modifier_list_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Child `CatalogModifierList`s that this `CatalogModifier` nests for multi-step choices.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogModifier`, set for CatalogObjects of type `MODIFIER`.',
      },
      time_period_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              event: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'An iCalendar (RFC 5545) event, which specifies the name, timing, duration and recurrence of this time period.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogTimePeriod`, set for CatalogObjects of type `TIME_PERIOD`.',
      },
      product_set_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'User-defined name for the product set.',
              },
              product_ids_any: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Unique IDs for any `CatalogObject` included in this product set.',
              },
              product_ids_all: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Unique IDs for any `CatalogObject` included in this product set.',
              },
              quantity_exact: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If set, there must be exactly this many items from `products_any` or `products_all` in the cart for the discount to apply.',
              },
              quantity_min: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If set, there must be at least this many items from `products_any` or `products_all` in a cart for the discount to apply.',
              },
              quantity_max: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If set, the pricing rule will apply to a maximum of this many items from `products_any` or `products_all`.',
              },
              all_products: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'If set to `true`, the product set will include every item in the catalog.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogProductSet`, set for CatalogObjects of type `PRODUCT_SET`.',
      },
      pricing_rule_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'User-defined name for the pricing rule.',
              },
              time_period_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A list of unique IDs for the catalog time periods when this pricing rule is in effect.',
              },
              discount_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Unique ID for the `CatalogDiscount` to take off the price of all matched items.',
              },
              match_products_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Unique ID for the `CatalogProductSet` that will be matched by this rule.',
              },
              apply_products_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  '__Deprecated__: Please use the `exclude_products_id` field to apply an exclude set instead.',
              },
              exclude_products_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: '`CatalogProductSet` to exclude from the pricing rule.',
              },
              valid_from_date: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Represents the date the Pricing Rule is valid from.',
              },
              valid_from_local_time: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Represents the local time the pricing rule should be valid from.',
              },
              valid_until_date: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Represents the date the Pricing Rule is valid until.',
              },
              valid_until_local_time: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Represents the local time the pricing rule should be valid until.',
              },
              exclude_strategy: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'If an `exclude_products_id` was given, controls which subset of matched products is excluded from any discounts.',
              },
              minimum_order_subtotal_money: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      amount: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                      },
                      currency: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of currency, in __ISO 4217 format__.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The minimum order subtotal (before discounts or taxes are applied) that must be met before this rule may be applied.',
              },
              customer_group_ids_any: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'A list of IDs of customer groups, the members of which are eligible for discounts specified in this pricing rule.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogPricingRule`, set for CatalogObjects of type `PRICING_RULE`.',
      },
      image_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The internal name to identify this image in calls to the Square API.',
              },
              url: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The URL of this image, generated by Square after an image is uploaded using the CreateCatalogImage endpoint.',
              },
              caption: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A caption that describes what is shown in the image.',
              },
              photo_studio_order_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The immutable order ID for this image object created by the Photo Studio service in Square Online Store.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogImage`, set for CatalogObjects of type `IMAGE`.',
      },
      measurement_unit_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              measurement_unit: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      custom_unit: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'A custom unit of measurement defined by the seller using the Point of Sale app or ad-hoc as an order line item.',
                      },
                      area_unit: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Represents a standard area unit.',
                      },
                      length_unit: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Represents a standard length unit.',
                      },
                      volume_unit: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Represents a standard volume unit.',
                      },
                      weight_unit: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Represents a standard unit of weight or mass.',
                      },
                      generic_unit: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Reserved for API integrations that lack the ability to specify a real measurement unit See MeasurementUnitGeneric for possible values',
                      },
                      time_unit: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Represents a standard unit of time.',
                      },
                      type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Represents the type of the measurement unit.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates the unit used to measure the quantity of a catalog item variation.',
              },
              precision: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'An integer between 0 and 5 that represents the maximum number of positions allowed after the decimal in quantities measured with this unit.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogMeasurementUnit`, set for CatalogObjects of type `MEASUREMENT_UNIT`.',
      },
      subscription_plan_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The name of the plan.',
              },
              phases: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        uid: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The Square-assigned ID of the subscription phase.',
                        },
                        cadence: {
                          type: 'string',
                          description: 'The billing cadence of the phase.',
                        },
                        periods: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The number of `cadence`s the phase lasts.',
                        },
                        recurring_price_money: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The amount to bill for each `cadence`.',
                        },
                        ordinal: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The position this phase appears in the sequence of phases defined for the plan, indexed from 0.',
                        },
                        pricing: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The subscription pricing.',
                        },
                      },
                      description: 'Describes a phase in a subscription plan variation.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A list of SubscriptionPhase containing the SubscriptionPhase for this plan.',
              },
              subscription_plan_variations: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      description: 'The wrapper object for the catalog entries of a given object type.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The list of subscription plan variations available for this product',
              },
              eligible_item_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "The list of IDs of `CatalogItems` that are eligible for subscription by this SubscriptionPlan's variations.",
              },
              eligible_category_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "The list of IDs of `CatalogCategory` that are eligible for subscription by this SubscriptionPlan's variations.",
              },
              all_items: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "If true, all items in the merchant's catalog are subscribable by this SubscriptionPlan.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogSubscriptionPlan`, set for CatalogObjects of type `SUBSCRIPTION_PLAN`.',
      },
      item_option_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item option's display name for the seller.",
              },
              display_name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item option's display name for the customer.",
              },
              description: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "The item option's human-readable description.",
              },
              show_colors: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'If true, display colors for entries in `values` when present.',
              },
              values: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      description: 'The wrapper object for the catalog entries of a given object type.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A list of CatalogObjects containing the `CatalogItemOptionValue`s for this item.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Structured data for a `CatalogItemOption`, set for CatalogObjects of type `ITEM_OPTION`.',
      },
      item_option_value_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              item_option_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Unique ID of the associated item option.',
              },
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Name of this item option value.',
              },
              description: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A human-readable description for the option value.',
              },
              color: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The HTML-supported hex color for the item option (e.g., "#ff8d4e85").',
              },
              ordinal: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Determines where this option value appears in a list of option values.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogItemOptionValue`, set for CatalogObjects of type `ITEM_OPTION_VAL`.',
      },
      custom_attribute_definition_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'The type of this custom attribute.',
              },
              name: {
                type: 'string',
                description: 'The name of this definition for API and seller-facing UI purposes.',
              },
              description: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'Seller-oriented description of the meaning of this Custom Attribute, any constraints that the seller should observe, etc.',
              },
              source_application: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      product: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: '__Read only__ The product type of the application.',
                      },
                      application_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: '__Read only__ The Square-assigned ID of the application.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          '__Read only__ The display name of the application (for example, `"Custom Application"` or `"Square POS 4.74 for Android"`).',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  '__Read only.__ Contains information about the application that created this custom attribute definition.',
              },
              allowed_object_types: {
                type: 'array',
                items: {
                  type: 'string',
                  description:
                    'Possible types of CatalogObjects returned from the catalog, each containing type-specific properties in the `*_data` field corresponding to the specified object type.',
                },
                description: 'The set of `CatalogObject` types that this custom atttribute may be applied to.',
              },
              seller_visibility: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The visibility of a custom attribute in seller-facing UIs (including Square Point of Sale applications and Square Dashboard).',
              },
              app_visibility: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The visibility of a custom attribute to applications other than the application that created the attribute.',
              },
              string_config: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      enforce_uniqueness: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          "If true, each Custom Attribute instance associated with this Custom Attribute Definition must have a unique value within the seller's catalog.",
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Optionally, populated when `type` = `STRING`, unset otherwise.',
              },
              number_config: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      precision: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'An integer between 0 and 5 that represents the maximum number of positions allowed after the decimal in number custom attribute values For example: - if the precision is 0, the quantity can be 1, 2, …',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Optionally, populated when `type` = `NUMBER`, unset otherwise.',
              },
              selection_config: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      max_allowed_selections: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The maximum number of selections that can be set.',
                      },
                      allowed_selections: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description: 'A named selection for this `SELECTION`-type custom attribute definition.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The set of valid `CatalogCustomAttributeSelections`.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Populated when `type` is set to `SELECTION`, unset otherwise.',
              },
              custom_attribute_usage_count: {
                type: 'integer',
                description: 'The number of custom attributes that reference this custom attribute definition.',
              },
              key: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The name of the desired custom attribute key that can be used to access the custom attribute value on catalog objects.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogCustomAttributeDefinition`, set for CatalogObjects of type `CUSTOM_ATTRIBUTE_DEFINITION`.',
      },
      quick_amounts_settings_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              option: {
                type: 'string',
                description: 'Represents the option seller currently uses on Quick Amounts.',
              },
              eligible_for_auto_amounts: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "Represents location's eligibility for auto amounts The boolean should be consistent with whether there are AUTO amounts in the `amounts`.",
              },
              amounts: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: {
                          type: 'string',
                          description: 'Represents the type of the Quick Amount.',
                        },
                        amount: {
                          type: 'object',
                          description: 'Represents the actual amount of the Quick Amount with Money type.',
                        },
                        score: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Describes the ranking of the Quick Amount provided by machine learning model, in the range [0, 100].',
                        },
                        ordinal: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The order in which this Quick Amount should be displayed.',
                        },
                      },
                      description: 'Represents a Quick Amount in the Catalog.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Represents a set of Quick Amounts at this location.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogQuickAmountsSettings`, set for CatalogObjects of type `QUICK_AMOUNTS_SETTINGS`.',
      },
      subscription_plan_variation_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The name of the plan variation.',
              },
              phases: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    uid: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The Square-assigned ID of the subscription phase.',
                    },
                    cadence: {
                      type: 'string',
                      description: 'The billing cadence of the phase.',
                    },
                    periods: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The number of `cadence`s the phase lasts.',
                    },
                    recurring_price_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The amount to bill for each `cadence`.',
                    },
                    ordinal: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The position this phase appears in the sequence of phases defined for the plan, indexed from 0.',
                    },
                    pricing: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The subscription pricing.',
                    },
                  },
                  description: 'Describes a phase in a subscription plan variation.',
                },
                description: 'A list containing each SubscriptionPhase for this plan variation.',
              },
              subscription_plan_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The id of the subscription plan, if there is one.',
              },
              monthly_billing_anchor_date: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The day of the month the billing period starts.',
              },
              can_prorate: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Whether bills for this plan variation can be split for proration.',
              },
              successor_plan_variation_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of a "successor" plan variation to this one.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogSubscriptionPlanVariation`, set for CatalogObjects of type `SUBSCRIPTION_PLAN_VARIATION`.',
      },
      availability_period_data: {
        anyOf: [
          {
            type: 'object',
            properties: {
              start_local_time: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The start time of an availability period, specified in local time using partial-time RFC 3339 format.',
              },
              end_local_time: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The end time of an availability period, specified in local time using partial-time RFC 3339 format.',
              },
              day_of_week: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The day of the week for this availability period.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Structured data for a `CatalogAvailabilityPeriod`, set for CatalogObjects of type `AVAILABILITY_PERIOD`.',
      },
    },
    description: 'The wrapper object for the catalog entries of a given object type.',
  },
  Order: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The order's unique ID.",
      },
      location_id: {
        type: 'string',
        description: 'The ID of the seller location that this order is associated with.',
      },
      reference_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A client-specified ID to associate an entity in another system with this order.',
      },
      source: {
        anyOf: [
          {
            type: 'object',
            properties: {
              name: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The name used to identify the place (physical or digital) that an order originates.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The latest source details of the order.',
      },
      customer_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the customer associated with the order.',
      },
      line_items: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uid: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A unique ID that identifies the line item only within this order.',
                },
                name: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The name of the line item.',
                },
                quantity: {
                  type: 'string',
                  description:
                    'The count, or measurement, of a line item being purchased: If `quantity` is a whole number, and `quantity_unit` is not specified, then `quantity` denotes an item count.',
                },
                quantity_unit: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        measurement_unit: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A MeasurementUnit that represents the unit of measure for the quantity.',
                        },
                        precision: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'For non-integer quantities, represents the number of digits after the decimal point that are recorded for this quantity.',
                        },
                        catalog_object_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The catalog object ID referencing the CatalogMeasurementUnit.',
                        },
                        catalog_version: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The version of the catalog object that this measurement unit references.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    "The measurement unit and decimal precision that this line item's quantity is measured in.",
                },
                note: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'An optional note associated with the line item.',
                },
                catalog_object_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The CatalogItemVariation ID applied to this line item.',
                },
                catalog_version: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The version of the catalog object that this line item references.',
                },
                variation_name: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The name of the variation applied to this line item.',
                },
                item_type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'The type of line item: an itemized sale, a non-itemized sale (custom amount), or the activation or reloading of a gift card.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Application-defined data attached to this line item.',
                },
                modifiers: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          uid: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'A unique ID that identifies the modifier only within this order.',
                          },
                          catalog_object_id: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'The catalog object ID referencing CatalogModifier.',
                          },
                          catalog_version: {
                            anyOf: [
                              {
                                type: 'integer',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'The version of the catalog object that this modifier references.',
                          },
                          name: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'The name of the item modifier.',
                          },
                          quantity: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'The quantity of the line item modifier.',
                          },
                          base_price_money: {
                            anyOf: [
                              {
                                type: 'object',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'The base price for the modifier.',
                          },
                          total_price_money: {
                            type: 'object',
                            description: 'The total price of the item modifier for its line item.',
                          },
                          metadata: {
                            anyOf: [
                              {
                                type: 'object',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'Application-defined data attached to this order.',
                          },
                          parent_modifier_uid: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description:
                              'The `uid` of the parent modifier, if this modifier is nested under another modifier.',
                          },
                        },
                        description: 'A CatalogModifier.',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The CatalogModifiers applied to this line item.',
                },
                applied_taxes: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          uid: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'A unique ID that identifies the applied tax only within this order.',
                          },
                          tax_uid: {
                            type: 'string',
                            description: 'The `uid` of the tax for which this applied tax represents.',
                          },
                          applied_money: {
                            type: 'object',
                            description: 'The amount of money applied by the tax to the line item.',
                          },
                          auto_applied: {
                            type: 'boolean',
                            description:
                              'Indicates whether the tax was automatically applied to the order based on the catalog configuration.',
                          },
                        },
                        description: 'Represents an applied portion of a tax to a line item in an order.',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The list of references to taxes applied to this line item.',
                },
                applied_discounts: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          uid: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'A unique ID that identifies the applied discount only within this order.',
                          },
                          discount_uid: {
                            type: 'string',
                            description: 'The `uid` of the discount that the applied discount represents.',
                          },
                          applied_money: {
                            type: 'object',
                            description: 'The amount of money applied by the discount to the line item.',
                          },
                        },
                        description: 'Represents an applied portion of a discount to a line item in an order.',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The list of references to discounts applied to this line item.',
                },
                applied_service_charges: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          uid: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description:
                              'A unique ID that identifies the applied service charge only within this order.',
                          },
                          service_charge_uid: {
                            type: 'string',
                            description: 'The `uid` of the service charge that the applied service charge represents.',
                          },
                          applied_money: {
                            type: 'object',
                            description: 'The amount of money applied by the service charge to the line item.',
                          },
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The list of references to service charges applied to this line item.',
                },
                base_price_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The base price for a single unit of the line item.',
                },
                variation_total_price_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total price of all item variations sold in this line item.',
                },
                gross_sales_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The amount of money made in gross sales for this line item.',
                },
                total_tax_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total amount of tax money to collect for the line item.',
                },
                total_discount_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total amount of discount money to collect for the line item.',
                },
                total_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total amount of money to collect for this line item.',
                },
                pricing_blocklists: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        blocked_discounts: {
                          anyOf: [
                            {
                              type: 'array',
                              items: {
                                type: 'object',
                                description: 'A discount to block from applying to a line item.',
                              },
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A list of discounts blocked from applying to the line item.',
                        },
                        blocked_taxes: {
                          anyOf: [
                            {
                              type: 'array',
                              items: {
                                type: 'object',
                                description: 'A tax to block from applying to a line item.',
                              },
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A list of taxes blocked from applying to the line item.',
                        },
                        blocked_service_charges: {
                          anyOf: [
                            {
                              type: 'array',
                              items: {
                                type: 'object',
                                description: 'A service charge to block from applying to a line item.',
                              },
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A list of service charges blocked from applying to the line item.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Describes pricing adjustments that are blocked from automatic application to a line item.',
                },
                total_service_charge_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total amount of apportioned service charge money to collect for the line item.',
                },
              },
              description: 'Represents a line item in an order.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The line items included in the order.',
      },
      taxes: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uid: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A unique ID that identifies the tax only within this order.',
                },
                catalog_object_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The catalog object ID referencing CatalogTax.',
                },
                catalog_version: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The version of the catalog object that this tax references.',
                },
                name: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: "The tax's name.",
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Indicates the calculation method used to apply the tax.',
                },
                percentage: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The percentage of the tax, as a string representation of a decimal number.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Application-defined data attached to this tax.',
                },
                applied_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount of money applied to the order by the tax.',
                },
                scope: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Indicates the level at which the tax applies.',
                },
                auto_applied: {
                  type: 'boolean',
                  description:
                    'Determines whether the tax was automatically applied to the order based on the catalog configuration.',
                },
              },
              description: 'Represents a tax that applies to one or more line item in the order.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The list of all taxes associated with the order.',
      },
      discounts: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uid: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A unique ID that identifies the discount only within this order.',
                },
                catalog_object_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The catalog object ID referencing CatalogDiscount.',
                },
                catalog_version: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The version of the catalog object that this discount references.',
                },
                name: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: "The discount's name.",
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The type of the discount.',
                },
                percentage: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The percentage of the discount, as a string representation of a decimal number.',
                },
                amount_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The total declared monetary amount of the discount.',
                },
                applied_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount of discount actually applied to the line item.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Application-defined data attached to this discount.',
                },
                scope: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Indicates the level at which the discount applies.',
                },
                reward_ids: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description: 'The reward IDs corresponding to this discount.',
                },
                pricing_rule_id: {
                  type: 'string',
                  description: 'The object ID of a pricing rule to be applied automatically to this discount.',
                },
              },
              description: 'Represents a discount that applies to one or more line items in an order.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The list of all discounts associated with the order.',
      },
      service_charges: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uid: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A unique ID that identifies the service charge only within this order.',
                },
                name: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The name of the service charge.',
                },
                catalog_object_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The catalog object ID referencing the service charge CatalogObject.',
                },
                catalog_version: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The version of the catalog object that this service charge references.',
                },
                percentage: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The service charge percentage as a string representation of a decimal number.',
                },
                amount_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The amount of a non-percentage-based service charge.',
                },
                applied_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description:
                    'The amount of money applied to the order by the service charge, including any inclusive tax amounts, as calculated by Square.',
                },
                total_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total amount of money to collect for the service charge.',
                },
                total_tax_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The total amount of tax money to collect for the service charge.',
                },
                calculation_phase: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The calculation phase at which to apply the service charge.',
                },
                taxable: {
                  anyOf: [
                    {
                      type: 'boolean',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Indicates whether the service charge can be taxed.',
                },
                applied_taxes: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          uid: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'A unique ID that identifies the applied tax only within this order.',
                          },
                          tax_uid: {
                            type: 'string',
                            description: 'The `uid` of the tax for which this applied tax represents.',
                          },
                          applied_money: {
                            type: 'object',
                            description: 'The amount of money applied by the tax to the line item.',
                          },
                          auto_applied: {
                            type: 'boolean',
                            description:
                              'Indicates whether the tax was automatically applied to the order based on the catalog configuration.',
                          },
                        },
                        description: 'Represents an applied portion of a tax to a line item in an order.',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The list of references to the taxes applied to this service charge.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Application-defined data attached to this service charge.',
                },
                type: {
                  type: 'string',
                  description: 'The type of the service charge.',
                },
                treatment_type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Indicates whether the service charge will be treated as a value-holding line item or apportioned toward a line item.',
                },
                scope: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Indicates the level at which the apportioned service charge applies.',
                },
              },
              description: 'Represents a service charge applied to an order.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'A list of service charges applied to the order.',
      },
      fulfillments: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uid: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A unique ID that identifies the fulfillment only within this order.',
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The type of the fulfillment.',
                },
                state: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The state of the fulfillment.',
                },
                line_item_application: {
                  type: 'string',
                  description: 'Describes what order line items this fulfillment applies to.',
                },
                entries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A unique ID that identifies the fulfillment entry only within this order.',
                      },
                      line_item_uid: {
                        type: 'string',
                        description: 'The `uid` from the order line item.',
                      },
                      quantity: {
                        type: 'string',
                        description: 'The quantity of the line item being fulfilled, formatted as a decimal number.',
                      },
                      metadata: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Application-defined data attached to this fulfillment entry.',
                      },
                    },
                    description: 'Links an order line item to a fulfillment.',
                  },
                  description: 'A list of entries pertaining to the fulfillment of an order.',
                },
                metadata: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Application-defined data attached to this fulfillment.',
                },
                pickup_details: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        recipient: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Information about the person to pick up this fulfillment from a physical location.',
                        },
                        expires_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The timestamp indicating when this fulfillment expires if it is not marked in progress.',
                        },
                        auto_complete_duration: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The duration after which an in-progress pickup fulfillment is automatically moved to the `COMPLETED` state.',
                        },
                        schedule_type: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The schedule type of the pickup fulfillment.',
                        },
                        pickup_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The timestamp that represents the start of the pickup window.',
                        },
                        pickup_window_duration: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The duration in which the order should be picked up after the `pickup_at` timestamp.',
                        },
                        prep_time_duration: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The duration needed to prepare this fulfillment.',
                        },
                        note: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'A note to provide additional instructions about the pickup fulfillment displayed in the Square Point of Sale application and set by the API.',
                        },
                        placed_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was placed.',
                        },
                        accepted_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was marked in progress.',
                        },
                        rejected_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was rejected.',
                        },
                        ready_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment is marked as ready for pickup.',
                        },
                        expired_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment expired.',
                        },
                        picked_up_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was picked up by the recipient.',
                        },
                        canceled_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was canceled.',
                        },
                        cancel_reason: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A description of why the pickup was canceled.',
                        },
                        is_curbside_pickup: {
                          anyOf: [
                            {
                              type: 'boolean',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'If set to `true`, indicates that this pickup order is for curbside pickup, not in-store pickup.',
                        },
                        curbside_pickup_details: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Specific details for curbside pickup.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Contains details for a pickup fulfillment.',
                },
                shipment_details: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        recipient: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Information about the person to receive this shipment fulfillment.',
                        },
                        carrier: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The shipping carrier being used to ship this fulfillment (such as UPS, FedEx, or USPS).',
                        },
                        shipping_note: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A note with additional information for the shipping carrier.',
                        },
                        shipping_type: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'A description of the type of shipping product purchased from the carrier (such as First Class, Priority, or Express).',
                        },
                        tracking_number: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: "The reference number provided by the carrier to track the shipment's progress.",
                        },
                        tracking_url: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: "A link to the tracking webpage on the carrier's website.",
                        },
                        placed_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the shipment was requested.',
                        },
                        in_progress_at: {
                          type: 'string',
                          description:
                            'The timestamp indicating when this fulfillment was moved to the `RESERVED` state, which indicates that preparation of this shipment has begun.',
                        },
                        packaged_at: {
                          type: 'string',
                          description:
                            'The timestamp indicating when this fulfillment was moved to the `PREPARED` state, which indicates that the fulfillment is packaged.',
                        },
                        expected_shipped_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The timestamp indicating when the shipment is expected to be delivered to the shipping carrier.',
                        },
                        shipped_at: {
                          type: 'string',
                          description:
                            'The timestamp indicating when this fulfillment was moved to the `COMPLETED` state, which indicates that the fulfillment has been given to the shipping carrier.',
                        },
                        canceled_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The timestamp indicating the shipment was canceled.',
                        },
                        cancel_reason: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A description of why the shipment was canceled.',
                        },
                        failed_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the shipment failed to be completed.',
                        },
                        failure_reason: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A description of why the shipment failed to be completed.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Contains details for a shipment fulfillment.',
                },
                delivery_details: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        recipient: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The contact information for the person to receive the fulfillment.',
                        },
                        schedule_type: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Indicates the fulfillment delivery schedule type.',
                        },
                        placed_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was placed.',
                        },
                        deliver_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The timestamp that represents the start of the delivery period.',
                        },
                        prep_time_duration: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The duration needed to prepare and deliver this fulfillment.',
                        },
                        delivery_window_duration: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The duration after `deliver_at` in which to deliver the order.',
                        },
                        note: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Provides additional instructions about the delivery fulfillment.',
                        },
                        completed_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The timestamp indicates when the seller completed the fulfillment.',
                        },
                        in_progress_at: {
                          type: 'string',
                          description: 'The timestamp indicates when the seller started processing the fulfillment.',
                        },
                        rejected_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was rejected.',
                        },
                        ready_at: {
                          type: 'string',
                          description:
                            'The timestamp indicating when the seller marked the fulfillment as ready for courier pickup.',
                        },
                        delivered_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was delivered to the recipient.',
                        },
                        canceled_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was canceled.',
                        },
                        cancel_reason: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The delivery cancellation reason.',
                        },
                        courier_pickup_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The timestamp indicating when an order can be picked up by the courier for delivery.',
                        },
                        courier_pickup_window_duration: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The duration after `courier_pickup_at` in which the courier should pick up the order.',
                        },
                        is_no_contact_delivery: {
                          anyOf: [
                            {
                              type: 'boolean',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Whether the delivery is preferred to be no contact.',
                        },
                        dropoff_notes: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'A note to provide additional instructions about how to deliver the order.',
                        },
                        courier_provider_name: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The name of the courier provider.',
                        },
                        courier_support_phone_number: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The support phone number of the courier.',
                        },
                        square_delivery_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The identifier for the delivery created by Square.',
                        },
                        external_delivery_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The identifier for the delivery created by the third-party courier service.',
                        },
                        managed_delivery: {
                          anyOf: [
                            {
                              type: 'boolean',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The flag to indicate the delivery is managed by a third party (ie DoorDash), which means we may not receive all recipient information for PII purposes.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Describes delivery details of an order fulfillment.',
                },
                in_store_details: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        note: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'A note to provide additional instructions about the in-store fulfillment displayed in the Square Point of Sale application and set by the API.',
                        },
                        recipient: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Information about the person to receive this in-store fulfillment.',
                        },
                        placed_at: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The timestamp indicating when the fulfillment was placed.',
                        },
                        completed_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was completed.',
                        },
                        in_progress_at: {
                          type: 'string',
                          description: 'The timestamp indicates when the seller started processing the fulfillment.',
                        },
                        prepared_at: {
                          type: 'string',
                          description:
                            'The timestamp indicating when the fulfillment was moved to the `PREPARED` state, which indicates that the fulfillment is ready.',
                        },
                        canceled_at: {
                          type: 'string',
                          description: 'The timestamp indicating when the fulfillment was canceled.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Contains details for an in-store fulfillment.',
                },
              },
              description: 'Contains details about how to fulfill this order.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details about order fulfillment.',
      },
      returns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            uid: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'A unique ID that identifies the return only within this order.',
            },
            source_order_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'An order that contains the original sale of these return line items.',
            },
            return_line_items: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A unique ID for this return line-item entry.',
                      },
                      source_line_item_uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The `uid` of the line item in the original sale order.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The name of the line item.',
                      },
                      quantity: {
                        type: 'string',
                        description: 'The quantity returned, formatted as a decimal number.',
                      },
                      quantity_unit: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: "The unit and precision that this return line item's quantity is measured in.",
                      },
                      note: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The note of the return line item.',
                      },
                      catalog_object_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The CatalogItemVariation ID applied to this return line item.',
                      },
                      catalog_version: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The version of the catalog object that this line item references.',
                      },
                      variation_name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The name of the variation applied to this return line item.',
                      },
                      item_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The type of line item: an itemized return, a non-itemized return (custom amount), or the return of an unactivated gift card sale.',
                      },
                      return_modifiers: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description: 'A line item modifier being returned.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The CatalogModifiers applied to this line item.',
                      },
                      applied_taxes: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description: 'Represents an applied portion of a tax to a line item in an order.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The list of references to `OrderReturnTax` entities applied to the return line item.',
                      },
                      applied_discounts: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description: 'Represents an applied portion of a discount to a line item in an order.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The list of references to `OrderReturnDiscount` entities applied to the return line item.',
                      },
                      base_price_money: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The base price for a single unit of the line item.',
                      },
                      variation_total_price_money: {
                        type: 'object',
                        description: 'The total price of all item variations returned in this line item.',
                      },
                      gross_return_money: {
                        type: 'object',
                        description:
                          'The gross return amount of money calculated as (item base price + modifiers price) * quantity.',
                      },
                      total_tax_money: {
                        type: 'object',
                        description: 'The total amount of tax money to return for the line item.',
                      },
                      total_discount_money: {
                        type: 'object',
                        description: 'The total amount of discount money to return for the line item.',
                      },
                      total_money: {
                        type: 'object',
                        description: 'The total amount of money to return for this line item.',
                      },
                      applied_service_charges: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The list of references to `OrderReturnServiceCharge` entities applied to the return line item.',
                      },
                      total_service_charge_money: {
                        type: 'object',
                        description:
                          'The total amount of apportioned service charge money to return for the line item.',
                      },
                    },
                    description: 'The line item being returned in an order.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'A collection of line items that are being returned.',
            },
            return_service_charges: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A unique ID that identifies the return service charge only within this order.',
                      },
                      source_service_charge_uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The service charge `uid` from the order containing the original service charge.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The name of the service charge.',
                      },
                      catalog_object_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The catalog object ID of the associated OrderServiceCharge.',
                      },
                      catalog_version: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The version of the catalog object that this service charge references.',
                      },
                      percentage: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The percentage of the service charge, as a string representation of a decimal number.',
                      },
                      amount_money: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The amount of a non-percentage-based service charge.',
                      },
                      applied_money: {
                        type: 'object',
                        description:
                          'The amount of money applied to the order by the service charge, including any inclusive tax amounts, as calculated by Square.',
                      },
                      total_money: {
                        type: 'object',
                        description: 'The total amount of money to collect for the service charge.',
                      },
                      total_tax_money: {
                        type: 'object',
                        description: 'The total amount of tax money to collect for the service charge.',
                      },
                      calculation_phase: {
                        type: 'string',
                        description: 'The calculation phase after which to apply the service charge.',
                      },
                      taxable: {
                        anyOf: [
                          {
                            type: 'boolean',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Indicates whether the surcharge can be taxed.',
                      },
                      applied_taxes: {
                        anyOf: [
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              description: 'Represents an applied portion of a tax to a line item in an order.',
                            },
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The list of references to `OrderReturnTax` entities applied to the `OrderReturnServiceCharge`.',
                      },
                      treatment_type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'Indicates whether the service charge will be treated as a value-holding line item or apportioned toward a line item.',
                      },
                      scope: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Indicates the level at which the apportioned service charge applies.',
                      },
                      type: {
                        type: 'string',
                        description: 'The type of the service charge.',
                      },
                    },
                    description: 'Represents the service charge applied to the original order.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'A collection of service charges that are being returned.',
            },
            return_taxes: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A unique ID that identifies the returned tax only within this order.',
                      },
                      source_tax_uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The tax `uid` from the order that contains the original tax charge.',
                      },
                      catalog_object_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The catalog object ID referencing CatalogTax.',
                      },
                      catalog_version: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The version of the catalog object that this tax references.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: "The tax's name.",
                      },
                      type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Indicates the calculation method used to apply the tax.',
                      },
                      percentage: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The percentage of the tax, as a string representation of a decimal number.',
                      },
                      applied_money: {
                        type: 'object',
                        description: 'The amount of money applied by the tax in an order.',
                      },
                      scope: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Indicates the level at which the `OrderReturnTax` applies.',
                      },
                    },
                    description:
                      'Represents a tax being returned that applies to one or more return line items in an order.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description:
                'A collection of references to taxes being returned for an order, including the total applied tax amount to be returned.',
            },
            return_discounts: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A unique ID that identifies the returned discount only within this order.',
                      },
                      source_discount_uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The discount `uid` from the order that contains the original application of this discount.',
                      },
                      catalog_object_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The catalog object ID referencing CatalogDiscount.',
                      },
                      catalog_version: {
                        anyOf: [
                          {
                            type: 'integer',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The version of the catalog object that this discount references.',
                      },
                      name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: "The discount's name.",
                      },
                      type: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The type of the discount.',
                      },
                      percentage: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The percentage of the tax, as a string representation of a decimal number.',
                      },
                      amount_money: {
                        anyOf: [
                          {
                            type: 'object',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The total declared monetary amount of the discount.',
                      },
                      applied_money: {
                        type: 'object',
                        description: 'The amount of discount actually applied to this line item.',
                      },
                      scope: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Indicates the level at which the `OrderReturnDiscount` applies.',
                      },
                    },
                    description:
                      'Represents a discount being returned that applies to one or more return line items in an order.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description:
                'A collection of references to discounts being returned for an order, including the total applied discount amount to be returned.',
            },
            return_tips: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'A unique ID that identifies the tip only within this order.',
                      },
                      applied_money: {
                        type: 'object',
                        description: 'The amount of tip being returned --',
                      },
                      source_tender_uid: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The tender `uid` from the order that contains the original application of this tip.',
                      },
                      source_tender_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description:
                          'The tender `id` from the order that contains the original application of this tip.',
                      },
                    },
                    description: 'A tip being returned.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'A collection of references to tips being returned for an order.',
            },
            rounding_adjustment: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    uid: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'A unique ID that identifies the rounding adjustment only within this order.',
                    },
                    name: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The name of the rounding adjustment from the original sale order.',
                    },
                    amount_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The actual rounding adjustment amount.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'A positive or negative rounding adjustment to the total value being returned.',
            },
            return_amounts: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    total_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The total money.',
                    },
                    tax_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The money associated with taxes.',
                    },
                    discount_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The money associated with discounts.',
                    },
                    tip_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The money associated with tips.',
                    },
                    service_charge_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The money associated with service charges.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'An aggregate monetary value being returned by this return entry.',
            },
          },
          description:
            'The set of line items, service charges, taxes, discounts, tips, and other items being returned in an order.',
        },
        description: 'A collection of items from sale orders being returned in this one.',
      },
      return_amounts: {
        type: 'object',
        properties: {
          total_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The total money.',
          },
          tax_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with taxes.',
          },
          discount_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with discounts.',
          },
          tip_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with tips.',
          },
          service_charge_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with service charges.',
          },
        },
        description: 'The rollup of the returned money amounts.',
      },
      net_amounts: {
        type: 'object',
        properties: {
          total_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The total money.',
          },
          tax_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with taxes.',
          },
          discount_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with discounts.',
          },
          tip_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with tips.',
          },
          service_charge_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The money associated with service charges.',
          },
        },
        description: 'The net money amounts (sale money - return money).',
      },
      rounding_adjustment: {
        type: 'object',
        properties: {
          uid: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'A unique ID that identifies the rounding adjustment only within this order.',
          },
          name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The name of the rounding adjustment from the original sale order.',
          },
          amount_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The actual rounding adjustment amount.',
          },
        },
        description: 'A positive rounding adjustment to the total of the order.',
      },
      tenders: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: "The tender's unique ID.",
            },
            location_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: "The ID of the transaction's associated location.",
            },
            transaction_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: "The ID of the tender's associated transaction.",
            },
            created_at: {
              type: 'string',
              description: 'The timestamp for when the tender was created, in RFC 3339 format.',
            },
            note: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'An optional note associated with the tender at the time of payment.',
            },
            amount_money: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The total amount of the tender, including `tip_money`.',
            },
            tip_money: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: "The tip's amount of the tender.",
            },
            processing_fee_money: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The amount of any Square processing fees applied to the tender.',
            },
            customer_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description:
                "If the tender is associated with a customer or represents a customer's card on file, this is the ID of the associated customer.",
            },
            type: {
              type: 'string',
              description: 'The type of tender, such as `CARD` or `CASH`.',
            },
            card_details: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    status: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: "The credit card payment's current state (such as `AUTHORIZED` or `CAPTURED`).",
                    },
                    card: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: "The credit card's non-confidential details.",
                    },
                    entry_method: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: "The method used to enter the card's details for the transaction.",
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The details of the card tender.',
            },
            cash_details: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    buyer_tendered_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The total amount of cash provided by the buyer, before change is given.',
                    },
                    change_back_money: {
                      anyOf: [
                        {
                          type: 'object',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The amount of change returned to the buyer.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The details of the cash tender.',
            },
            bank_account_details: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    status: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: "The bank account payment's current state.",
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The details of the bank account tender.',
            },
            buy_now_pay_later_details: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    buy_now_pay_later_brand: {
                      type: 'string',
                      description: 'The Buy Now Pay Later brand.',
                    },
                    status: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        "The buy now pay later payment's current state (such as `AUTHORIZED` or `CAPTURED`).",
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The details of a Buy Now Pay Later tender.',
            },
            square_account_details: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    status: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: "The Square Account payment's current state (such as `AUTHORIZED` or `CAPTURED`).",
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The details of a Square Account tender.',
            },
            additional_recipients: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      location_id: {
                        type: 'string',
                        description:
                          'The location ID for a recipient (other than the merchant) receiving a portion of this tender.',
                      },
                      description: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The description of the additional recipient.',
                      },
                      amount_money: {
                        type: 'object',
                        description: 'The amount of money distributed to the recipient.',
                      },
                      receivable_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The unique ID for the RETIRED `AdditionalRecipientReceivable` object.',
                      },
                    },
                    description:
                      'Represents an additional recipient (other than the merchant) receiving a portion of this tender.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'Additional recipients (other than the merchant) receiving a portion of this tender.',
            },
            payment_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The ID of the Payment that corresponds to this tender.',
            },
          },
          description: 'Represents a tender (i.e., a method of payment) used in a Square transaction.',
        },
        description: 'The tenders that were used to pay for the order.',
      },
      refunds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: "The refund's unique ID.",
            },
            location_id: {
              type: 'string',
              description: "The ID of the refund's associated location.",
            },
            transaction_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The ID of the transaction that the refunded tender is part of.',
            },
            tender_id: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The ID of the refunded tender.',
            },
            created_at: {
              type: 'string',
              description: 'The timestamp for when the refund was created, in RFC 3339 format.',
            },
            reason: {
              type: 'string',
              description: 'The reason for the refund being issued.',
            },
            amount_money: {
              type: 'object',
              properties: {
                amount: {
                  anyOf: [
                    {
                      type: 'integer',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                },
                currency: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The type of currency, in __ISO 4217 format__.',
                },
              },
              description: 'The amount of money refunded to the buyer.',
            },
            status: {
              type: 'string',
              description: 'The current status of the refund (`PENDING`, `APPROVED`, `REJECTED`, or `FAILED`).',
            },
            processing_fee_money: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The amount of Square processing fee money refunded to the *merchant*.',
            },
            additional_recipients: {
              anyOf: [
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      location_id: {
                        type: 'string',
                        description:
                          'The location ID for a recipient (other than the merchant) receiving a portion of this tender.',
                      },
                      description: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The description of the additional recipient.',
                      },
                      amount_money: {
                        type: 'object',
                        description: 'The amount of money distributed to the recipient.',
                      },
                      receivable_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The unique ID for the RETIRED `AdditionalRecipientReceivable` object.',
                      },
                    },
                    description:
                      'Represents an additional recipient (other than the merchant) receiving a portion of this tender.',
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'Additional recipients (other than the merchant) receiving a portion of this refund.',
            },
          },
          description: 'Represents a refund processed for a Square transaction.',
        },
        description: 'The refunds that are part of this order.',
      },
      metadata: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Application-defined data attached to this order.',
      },
      created_at: {
        type: 'string',
        description:
          'The timestamp for when the order was created, at server side, in RFC 3339 format (for example, "2016-09-04T23:59:33.123Z").',
      },
      updated_at: {
        type: 'string',
        description:
          'The timestamp for when the order was last updated, at server side, in RFC 3339 format (for example, "2016-09-04T23:59:33.123Z").',
      },
      closed_at: {
        type: 'string',
        description:
          'The timestamp for when the order reached a terminal state, in RFC 3339 format (for example "2016-09-04T23:59:33.123Z").',
      },
      state: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The current state of the order.',
      },
      version: {
        type: 'integer',
        description: 'The version number, which is incremented each time an update is committed to the order.',
      },
      total_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount of money to collect for the order.',
      },
      total_tax_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount of tax money to collect for the order.',
      },
      total_discount_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount of discount money to collect for the order.',
      },
      total_tip_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount of tip money to collect for the order.',
      },
      total_service_charge_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount of money collected in service charges for the order.',
      },
      ticket_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'A short-term identifier for the order (such as a customer first name, table number, or auto-generated order number that resets daily).',
      },
      pricing_options: {
        anyOf: [
          {
            type: 'object',
            properties: {
              auto_apply_discounts: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The option to determine whether pricing rule-based discounts are automatically applied to an order.',
              },
              auto_apply_taxes: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The option to determine whether rule-based taxes are automatically applied to an order when the criteria of the corresponding rules are met.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Pricing options for an order.',
      },
      rewards: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The identifier of the reward.',
            },
            reward_tier_id: {
              type: 'string',
              description: 'The identifier of the reward tier corresponding to this reward.',
            },
          },
          description:
            'Represents a reward that can be applied to an order if the necessary reward tier criteria are met.',
        },
        description: 'A set-like list of Rewards that have been added to the Order.',
      },
      net_amount_due_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The net amount of money due on the order.',
      },
    },
    description:
      'Contains all information related to a single order to process with Square, including line items that specify the products to purchase.',
  },
  Payment: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'A unique ID for the payment.',
      },
      created_at: {
        type: 'string',
        description: 'The timestamp of when the payment was created, in RFC 3339 format.',
      },
      updated_at: {
        type: 'string',
        description: 'The timestamp of when the payment was last updated, in RFC 3339 format.',
      },
      amount_money: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
              },
              currency: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of currency, in __ISO 4217 format__.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The amount processed for this payment, not including `tip_money`.',
      },
      tip_money: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
              },
              currency: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of currency, in __ISO 4217 format__.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: "The amount designated as a tip for the seller's staff.",
      },
      total_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount for the payment, including `amount_money` and `tip_money`.',
      },
      app_fee_money: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
              },
              currency: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of currency, in __ISO 4217 format__.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'The amount the developer is taking as a fee for facilitating the payment on behalf of the seller.',
      },
      app_fee_allocations: {
        anyOf: [
          {
            type: 'array',
            items: {},
          },
          {
            type: 'null',
          },
        ],
        description: 'Details pertaining to recipients of the application fee.',
      },
      approved_money: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
              },
              currency: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of currency, in __ISO 4217 format__.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The amount of money approved for this payment.',
      },
      processing_fee: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            effective_at: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The timestamp of when the fee takes effect, in RFC 3339 format.',
            },
            type: {
              anyOf: [
                {
                  type: 'string',
                },
                {
                  type: 'null',
                },
              ],
              description: 'The type of fee assessed or adjusted.',
            },
            amount_money: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                },
                {
                  type: 'null',
                },
              ],
              description: 'The fee amount, which might be negative, that is assessed or adjusted by Square.',
            },
          },
          description: 'Represents the Square processing fee.',
        },
        description: 'The processing fees and fee adjustments assessed by Square for this payment.',
      },
      refunded_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The total amount of the payment refunded to date.',
      },
      status: {
        type: 'string',
        description: 'Indicates whether the payment is APPROVED, PENDING, COMPLETED, CANCELED, or FAILED.',
      },
      delay_duration: {
        type: 'string',
        description:
          "The duration of time after the payment's creation when Square automatically applies the `delay_action` to the payment.",
      },
      delay_action: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The action to be applied to the payment when the `delay_duration` has elapsed.',
      },
      delayed_until: {
        type: 'string',
        description: 'The read-only timestamp of when the `delay_action` is automatically applied, in RFC 3339 format.',
      },
      source_type: {
        type: 'string',
        description: 'The source type for this payment.',
      },
      card_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                description: "The card payment's current state.",
              },
              card: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Unique ID for this card.',
                  },
                  card_brand: {
                    type: 'string',
                    description: "The card's brand.",
                  },
                  last_4: {
                    type: 'string',
                    description: 'The last 4 digits of the card number.',
                  },
                  exp_month: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The expiration month of the associated card as an integer between 1 and 12.',
                  },
                  exp_year: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The four-digit year of the card's expiration date.",
                  },
                  cardholder_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The name of the cardholder.',
                  },
                  billing_address: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The billing address for this card.',
                  },
                  fingerprint: {
                    type: 'string',
                    description:
                      'Intended as a Square-assigned identifier, based on the card number, to identify the card across multiple locations within a single application.',
                  },
                  customer_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: '**Required** The ID of a customer to be associated with the card.',
                  },
                  merchant_id: {
                    type: 'string',
                    description: 'The ID of the merchant associated with the card.',
                  },
                  reference_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'An optional user-defined reference ID that associates this card with another entity in an external system.',
                  },
                  enabled: {
                    type: 'boolean',
                    description: 'Indicates whether or not a card can be used for payments.',
                  },
                  card_type: {
                    type: 'string',
                    description: 'The type of the card.',
                  },
                  prepaid_type: {
                    type: 'string',
                    description: 'Indicates whether the card is prepaid or not.',
                  },
                  bin: {
                    type: 'string',
                    description:
                      'The first six digits of the card number, known as the Bank Identification Number (BIN).',
                  },
                  created_at: {
                    type: 'string',
                    description: 'Timestamp for when the card object was created on Square’s servers.',
                  },
                  disabled_at: {
                    type: 'string',
                    description: 'Timestamp for when the card object was disabled on Square’s servers.',
                  },
                  version: {
                    type: 'integer',
                    description: 'Current version number of the card.',
                  },
                  card_co_brand: {
                    type: 'string',
                    description: "The card's co-brand if available.",
                  },
                  issuer_alert: {
                    type: 'string',
                    description: 'An alert from the issuing bank about the card status.',
                  },
                  issuer_alert_at: {
                    type: 'string',
                    description:
                      'The timestamp of when the current issuer alert was received and processed, in RFC 3339 format.',
                  },
                  hsa_fsa: {
                    type: 'boolean',
                    description:
                      'Indicates whether the card is linked to a Health Savings Account (HSA) or Flexible Spending Account (FSA), based on the card BIN.',
                  },
                },
                description: "The credit card's non-confidential details.",
              },
              entry_method: {
                type: 'string',
                description: "The method used to enter the card's details for the payment.",
              },
              cvv_status: {
                type: 'string',
                description: 'The status code returned from the Card Verification Value (CVV) check.',
              },
              avs_status: {
                type: 'string',
                description: 'The status code returned from the Address Verification System (AVS) check.',
              },
              auth_result_code: {
                type: 'string',
                description:
                  "The status code returned by the card issuer that describes the payment's authorization status.",
              },
              application_identifier: {
                type: 'string',
                description:
                  'For EMV payments, the application ID identifies the EMV application used for the payment.',
              },
              application_name: {
                type: 'string',
                description: 'For EMV payments, the human-readable name of the EMV application used for the payment.',
              },
              application_cryptogram: {
                type: 'string',
                description: 'For EMV payments, the cryptogram generated for the payment.',
              },
              verification_method: {
                type: 'string',
                description: "For EMV payments, the method used to verify the cardholder's identity.",
              },
              verification_results: {
                type: 'string',
                description: 'For EMV payments, the results of the cardholder verification.',
              },
              statement_description: {
                type: 'string',
                description: 'The statement description sent to the card networks.',
              },
              device_details: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      device_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The Square-issued ID of the device.',
                      },
                      device_installation_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The Square-issued installation ID for the device.',
                      },
                      device_name: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The name of the device set by the seller.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: '__Deprecated__: Use `Payment.device_details` instead.',
              },
              card_payment_timeline: {
                type: 'object',
                properties: {
                  authorized_at: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp when the payment was authorized, in RFC 3339 format.',
                  },
                  captured_at: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp when the payment was captured, in RFC 3339 format.',
                  },
                  voided_at: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The timestamp when the payment was voided, in RFC 3339 format.',
                  },
                },
                description: 'The timeline for card payments.',
              },
              refund_requires_card_presence: {
                type: 'boolean',
                description: 'Whether the card must be physically present for the payment to be refunded.',
              },
              errors: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: {
                      type: 'string',
                      description: 'The high-level category for the error.',
                    },
                    code: {
                      type: 'string',
                      description: 'The specific code of the error.',
                    },
                    detail: {
                      type: 'string',
                      description: 'A human-readable description of the error for debugging purposes.',
                    },
                    field: {
                      type: 'string',
                      description:
                        'The name of the field provided in the original request (if any) that the error pertains to.',
                    },
                  },
                  description: 'Represents an error encountered during a request to the Connect API.',
                },
                description: 'Information about errors encountered during the request.',
              },
              applied_card_surcharge_details: {
                type: 'object',
                properties: {
                  card_surcharge_money: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'A specific surcharge levied by the merchant, if a card payment is used, instead of cash or some other payment type.',
                  },
                },
                description: 'Additional information about a card_surcharge on the payment.',
              },
              wallet_type: {
                type: 'string',
                description: 'The type of digital wallet used for this card payment, if applicable.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details about a card payment.',
      },
      cash_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              buyer_supplied_money: {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
                description: 'The amount and currency of the money supplied by the buyer.',
              },
              change_back_money: {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
                description: 'The amount of change due back to the buyer.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details about a cash payment.',
      },
      bank_account_details: {
        type: 'object',
        properties: {
          bank_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The name of the bank associated with the bank account.',
          },
          transfer_type: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of the bank transfer.',
          },
          account_ownership_type: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The ownership type of the bank account performing the transfer.',
          },
          fingerprint: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'Uniquely identifies the bank account for this seller and can be used to determine if payments are from the same bank account.',
          },
          country: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The two-letter ISO code representing the country the bank account is located in.',
          },
          statement_description: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The statement description as sent to the bank.',
          },
          ach_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  routing_number: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The routing number for the bank account.',
                  },
                  account_number_suffix: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The last few digits of the bank account number.',
                  },
                  account_type: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of the bank account performing the transfer.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'ACH-specific information about the transfer.',
          },
          errors: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: {
                      type: 'string',
                      description: 'The high-level category for the error.',
                    },
                    code: {
                      type: 'string',
                      description: 'The specific code of the error.',
                    },
                    detail: {
                      type: 'string',
                      description: 'A human-readable description of the error for debugging purposes.',
                    },
                    field: {
                      type: 'string',
                      description:
                        'The name of the field provided in the original request (if any) that the error pertains to.',
                    },
                  },
                  description: 'Represents an error encountered during a request to the Connect API.',
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Information about errors encountered during the request.',
          },
        },
        description: 'Details about a bank account payment.',
      },
      electronic_money_details: {
        anyOf: [
          {
            type: 'object',
            properties: {
              felica_details: {
                anyOf: [
                  {
                    type: 'object',
                    properties: {
                      terminal_id: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The terminal id for a Felica payment.',
                      },
                      felica_masked_card_number: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The masked card number for a Felica payment.',
                      },
                      felica_brand: {
                        anyOf: [
                          {
                            type: 'string',
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'The Felica sub-brand of the payment.',
                      },
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Details specific to FeliCa payments.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Details specific to electronic money payments.',
      },
      external_details: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'The type of external payment the seller received.',
          },
          source: {
            type: 'string',
            description: 'A description of the external payment source.',
          },
          source_id: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'An ID to associate the payment to its originating source.',
          },
          source_fee_money: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  amount: {
                    anyOf: [
                      {
                        type: 'integer',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description:
                      'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                  },
                  currency: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The type of currency, in __ISO 4217 format__.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'The fees paid to the source.',
          },
        },
        description: 'Details about an external payment.',
      },
      wallet_details: {
        type: 'object',
        properties: {
          status: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The status of the `WALLET` payment.',
          },
          brand: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The brand used for the `WALLET` payment.',
          },
          cash_app_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  buyer_full_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The name of the Cash App account holder.',
                  },
                  buyer_country_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The country of the Cash App account holder, in ISO 3166-1-alpha-2 format.',
                  },
                  buyer_cashtag: {
                    type: 'string',
                    description: '$Cashtag of the Cash App account holder.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Brand-specific details for payments with the `brand` of `CASH_APP`.',
          },
          lightning_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  payment_url: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'Payment URL for the lightning payment, a.k.a.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Brand-specific details for payments with the `brand` of `LIGHTNING`.',
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  description: 'The high-level category for the error.',
                },
                code: {
                  type: 'string',
                  description: 'The specific code of the error.',
                },
                detail: {
                  type: 'string',
                  description: 'A human-readable description of the error for debugging purposes.',
                },
                field: {
                  type: 'string',
                  description:
                    'The name of the field provided in the original request (if any) that the error pertains to.',
                },
              },
              description: 'Represents an error encountered during a request to the Connect API.',
            },
            description: 'Information about errors encountered during the payment.',
          },
        },
        description: 'Details about an wallet payment.',
      },
      buy_now_pay_later_details: {
        type: 'object',
        properties: {
          brand: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The brand used for the Buy Now Pay Later payment.',
          },
          afterpay_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  email_address: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Email address on the buyer's Afterpay account.",
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Details about an Afterpay payment.',
          },
          clearpay_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  email_address: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Email address on the buyer's Clearpay account.",
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Details about a Clearpay payment.',
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  description: 'The high-level category for the error.',
                },
                code: {
                  type: 'string',
                  description: 'The specific code of the error.',
                },
                detail: {
                  type: 'string',
                  description: 'A human-readable description of the error for debugging purposes.',
                },
                field: {
                  type: 'string',
                  description:
                    'The name of the field provided in the original request (if any) that the error pertains to.',
                },
              },
              description: 'Represents an error encountered during a request to the Connect API.',
            },
            description: 'Information about errors encountered during the payment.',
          },
        },
        description: 'Details about a Buy Now Pay Later payment.',
      },
      square_account_details: {
        type: 'object',
        properties: {
          payment_source_token: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'Unique identifier for the payment source used for this payment.',
          },
          errors: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    category: {
                      type: 'string',
                      description: 'The high-level category for the error.',
                    },
                    code: {
                      type: 'string',
                      description: 'The specific code of the error.',
                    },
                    detail: {
                      type: 'string',
                      description: 'A human-readable description of the error for debugging purposes.',
                    },
                    field: {
                      type: 'string',
                      description:
                        'The name of the field provided in the original request (if any) that the error pertains to.',
                    },
                  },
                  description: 'Represents an error encountered during a request to the Connect API.',
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Information about errors encountered during the request.',
          },
        },
        description: 'Details about a Square Account payment.',
      },
      location_id: {
        type: 'string',
        description: 'The ID of the location associated with the payment.',
      },
      order_id: {
        type: 'string',
        description: 'The ID of the order associated with the payment.',
      },
      reference_id: {
        type: 'string',
        description: 'An optional ID that associates the payment with an entity in another system.',
      },
      customer_id: {
        type: 'string',
        description: 'The ID of the customer associated with the payment.',
      },
      employee_id: {
        type: 'string',
        description: '__Deprecated__: Use `Payment.team_member_id` instead.',
      },
      team_member_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'An optional ID of the TeamMember associated with taking the payment.',
      },
      refund_ids: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'A list of `refund_id`s identifying refunds for the payment.',
      },
      risk_evaluation: {
        type: 'object',
        properties: {
          created_at: {
            type: 'string',
            description: 'The timestamp when payment risk was evaluated, in RFC 3339 format.',
          },
          risk_level: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The risk level associated with the payment See RiskEvaluationRiskLevel for possible values',
          },
        },
        description: 'Provides information about the risk associated with the payment, as determined by Square.',
      },
      terminal_checkout_id: {
        type: 'string',
        description: 'An optional ID for a Terminal checkout that is associated with the payment.',
      },
      buyer_email_address: {
        type: 'string',
        description: "The buyer's email address.",
      },
      billing_address: {
        type: 'object',
        properties: {
          address_line_1: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The first line of the address.',
          },
          address_line_2: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The second line of the address, if any.',
          },
          address_line_3: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The third line of the address, if any.',
          },
          locality: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The city or town of the address.',
          },
          sublocality: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil region within the address's `locality`, if any.",
          },
          sublocality_2: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil region within the address's `sublocality`, if any.",
          },
          sublocality_3: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil region within the address's `sublocality_2`, if any.",
          },
          administrative_district_level_1: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil entity within the address's country.",
          },
          administrative_district_level_2: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil entity within the address's `administrative_district_level_1`.",
          },
          administrative_district_level_3: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil entity within the address's `administrative_district_level_2`, if any.",
          },
          postal_code: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "The address's postal code.",
          },
          country: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "The address's country, in the two-letter format of ISO 3166.",
          },
          first_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "Optional first name when it's representing recipient.",
          },
          last_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "Optional last name when it's representing recipient.",
          },
        },
        description: "The buyer's billing address.",
      },
      shipping_address: {
        type: 'object',
        properties: {
          address_line_1: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The first line of the address.',
          },
          address_line_2: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The second line of the address, if any.',
          },
          address_line_3: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The third line of the address, if any.',
          },
          locality: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The city or town of the address.',
          },
          sublocality: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil region within the address's `locality`, if any.",
          },
          sublocality_2: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil region within the address's `sublocality`, if any.",
          },
          sublocality_3: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil region within the address's `sublocality_2`, if any.",
          },
          administrative_district_level_1: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil entity within the address's country.",
          },
          administrative_district_level_2: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil entity within the address's `administrative_district_level_1`.",
          },
          administrative_district_level_3: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "A civil entity within the address's `administrative_district_level_2`, if any.",
          },
          postal_code: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "The address's postal code.",
          },
          country: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "The address's country, in the two-letter format of ISO 3166.",
          },
          first_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "Optional first name when it's representing recipient.",
          },
          last_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: "Optional last name when it's representing recipient.",
          },
        },
        description: "The buyer's shipping address.",
      },
      note: {
        type: 'string',
        description: 'An optional note to include when creating a payment.',
      },
      statement_description_identifier: {
        type: 'string',
        description:
          "Additional payment information that gets added to the customer's card statement as part of the statement description.",
      },
      capabilities: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Actions that can be performed on this payment: - `EDIT_AMOUNT_UP` - The payment amount can be edited up.',
      },
      receipt_number: {
        type: 'string',
        description: "The payment's receipt number.",
      },
      receipt_url: {
        type: 'string',
        description: "The URL for the payment's receipt.",
      },
      device_details: {
        type: 'object',
        properties: {
          device_id: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The Square-issued ID of the device.',
          },
          device_installation_id: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The Square-issued installation ID for the device.',
          },
          device_name: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The name of the device set by the seller.',
          },
        },
        description: 'Details about the device that took the payment.',
      },
      application_details: {
        type: 'object',
        properties: {
          square_product: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description:
              'The Square product, such as Square Point of Sale (POS), Square Invoices, or Square Virtual Terminal.',
          },
          application_id: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The Square ID assigned to the application used to take the payment.',
          },
        },
        description: 'Details about the application that took the payment.',
      },
      buyer_currency_exchange: {
        description:
          'Details about the currency exchange for payments where the currency the buyer paid with differs from the currency the merchant received (e.g., bitcoin lightning payments).',
      },
      is_offline_payment: {
        type: 'boolean',
        description: 'Whether or not this payment was taken offline.',
      },
      offline_payment_details: {
        type: 'object',
        properties: {
          client_created_at: {
            type: 'string',
            description: 'The client-side timestamp of when the offline payment was created, in RFC 3339 format.',
          },
        },
        description: 'Additional information about the payment if it was taken offline.',
      },
      version_token: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Used for optimistic concurrency.',
      },
    },
    description: 'Represents a payment processed by the Square API.',
  },
  PaymentRefund: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The unique ID for this refund, generated by Square.',
      },
      status: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The refund's status: - `PENDING` - Awaiting approval.",
      },
      location_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The location ID associated with the payment this refund is attached to.',
      },
      unlinked: {
        type: 'boolean',
        description: 'Flag indicating whether or not the refund is linked to an existing payment in Square.',
      },
      destination_type: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The destination type for this refund.',
      },
      destination_details: {
        type: 'object',
        properties: {
          card_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  card: {
                    anyOf: [
                      {
                        type: 'object',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The card's non-confidential details.",
                  },
                  entry_method: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The method used to enter the card's details for the refund.",
                  },
                  auth_result_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The authorization code provided by the issuer when a refund is approved.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Details about a card refund.',
          },
          cash_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  seller_supplied_money: {
                    type: 'object',
                    description: 'The amount and currency of the money supplied by the seller.',
                  },
                  change_back_money: {
                    type: 'object',
                    description: 'The amount of change due back to the seller.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Details about a cash refund.',
          },
          external_details: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    description: 'The type of external refund the seller paid to the buyer.',
                  },
                  source: {
                    type: 'string',
                    description: 'A description of the external refund source.',
                  },
                  source_id: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'An ID to associate the refund to its originating source.',
                  },
                },
              },
              {
                type: 'null',
              },
            ],
            description: 'Details about an external refund.',
          },
        },
        description: 'Contains information about the refund destination.',
      },
      amount_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The amount of money refunded.',
      },
      app_fee_money: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
              },
              currency: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of currency, in __ISO 4217 format__.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The amount of money the application developer contributed to help cover the refunded amount.',
      },
      app_fee_allocations: {
        type: 'array',
        items: {},
        description: 'Details pertaining to contributors to the refund of the application fee.',
      },
      processing_fee: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                effective_at: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The timestamp of when the fee takes effect, in RFC 3339 format.',
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The type of fee assessed or adjusted.',
                },
                amount_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The fee amount, which might be negative, that is assessed or adjusted by Square.',
                },
              },
              description: 'Represents the Square processing fee.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Processing fees and fee adjustments assessed by Square for this refund.',
      },
      payment_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the payment associated with this refund.',
      },
      order_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the order associated with the refund.',
      },
      reason: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The reason for the refund.',
      },
      created_at: {
        type: 'string',
        description: 'The timestamp of when the refund was created, in RFC 3339 format.',
      },
      updated_at: {
        type: 'string',
        description: 'The timestamp of when the refund was last updated, in RFC 3339 format.',
      },
      team_member_id: {
        type: 'string',
        description: 'An optional ID of the team member associated with taking the payment.',
      },
      terminal_refund_id: {
        type: 'string',
        description: 'An optional ID for a Terminal refund.',
      },
    },
    description: 'Represents a refund of a payment made using Square.',
  },
  Invoice: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Square-assigned ID of the invoice.',
      },
      version: {
        type: 'integer',
        description:
          'The Square-assigned version number, which is incremented each time an update is committed to the invoice.',
      },
      location_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the location that this invoice is associated with.',
      },
      order_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The ID of the order for which the invoice is created.',
      },
      primary_recipient: {
        anyOf: [
          {
            type: 'object',
            properties: {
              customer_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the customer.',
              },
              given_name: {
                type: 'string',
                description: "The recipient's given (that is, first) name.",
              },
              family_name: {
                type: 'string',
                description: "The recipient's family (that is, last) name.",
              },
              email_address: {
                type: 'string',
                description: "The recipient's email address.",
              },
              address: {
                type: 'object',
                properties: {
                  address_line_1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The first line of the address.',
                  },
                  address_line_2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The second line of the address, if any.',
                  },
                  address_line_3: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The third line of the address, if any.',
                  },
                  locality: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The city or town of the address.',
                  },
                  sublocality: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "A civil region within the address's `locality`, if any.",
                  },
                  sublocality_2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "A civil region within the address's `sublocality`, if any.",
                  },
                  sublocality_3: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "A civil region within the address's `sublocality_2`, if any.",
                  },
                  administrative_district_level_1: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "A civil entity within the address's country.",
                  },
                  administrative_district_level_2: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "A civil entity within the address's `administrative_district_level_1`.",
                  },
                  administrative_district_level_3: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "A civil entity within the address's `administrative_district_level_2`, if any.",
                  },
                  postal_code: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The address's postal code.",
                  },
                  country: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "The address's country, in the two-letter format of ISO 3166.",
                  },
                  first_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Optional first name when it's representing recipient.",
                  },
                  last_name: {
                    anyOf: [
                      {
                        type: 'string',
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: "Optional last name when it's representing recipient.",
                  },
                },
                description: "The recipient's physical address.",
              },
              phone_number: {
                type: 'string',
                description: "The recipient's phone number.",
              },
              company_name: {
                type: 'string',
                description: "The name of the recipient's company.",
              },
              tax_ids: {
                type: 'object',
                properties: {
                  eu_vat: {
                    type: 'string',
                    description: 'The EU VAT identification number for the invoice recipient.',
                  },
                },
                description: "The recipient's tax IDs.",
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The customer who receives the invoice.',
      },
      payment_requests: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uid: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The Square-generated ID of the payment request in an invoice.',
                },
                request_method: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Indicates how Square processes the payment request.',
                },
                request_type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Identifies the payment request type.',
                },
                due_date: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    "The due date (in the invoice's time zone) for the payment request, in `YYYY-MM-DD` format.",
                },
                fixed_amount_requested_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'If the payment request specifies `DEPOSIT` or `INSTALLMENT` as the `request_type`, this indicates the request amount.',
                },
                percentage_requested: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    "Specifies the amount for the payment request in percentage: - When the payment `request_type` is `DEPOSIT`, it is the percentage of the order's total amount.",
                },
                tipping_enabled: {
                  anyOf: [
                    {
                      type: 'boolean',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'If set to true, the Square-hosted invoice page (the `public_url` field of the invoice) provides a place for the customer to pay a tip.',
                },
                automatic_payment_source: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The payment method for an automatic payment.',
                },
                card_id: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The ID of the credit or debit card on file to charge for the payment request.',
                },
                reminders: {
                  anyOf: [
                    {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          uid: {
                            type: 'string',
                            description:
                              'A Square-assigned ID that uniquely identifies the reminder within the `InvoicePaymentRequest`.',
                          },
                          relative_scheduled_days: {
                            anyOf: [
                              {
                                type: 'integer',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description:
                              'The number of days before (a negative number) or after (a positive number) the payment request `due_date` when the reminder is sent.',
                          },
                          message: {
                            anyOf: [
                              {
                                type: 'string',
                              },
                              {
                                type: 'null',
                              },
                            ],
                            description: 'The reminder message.',
                          },
                          status: {
                            type: 'string',
                            description: 'The status of the reminder.',
                          },
                          sent_at: {
                            type: 'string',
                            description: 'If sent, the timestamp when the reminder was sent, in RFC 3339 format.',
                          },
                        },
                        description:
                          'Describes a payment request reminder (automatic notification) that Square sends to the customer.',
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'A list of one or more reminders to send for the payment request.',
                },
                computed_amount_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description:
                    'The amount of the payment request, computed using the order amount and information from the various payment request fields (`request_type`, `fixed_amount_requested_money`, and `percentage_requested`).',
                },
                total_completed_amount_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description: 'The amount of money already paid for the specific payment request.',
                },
                rounding_adjustment_included_money: {
                  type: 'object',
                  properties: {
                    amount: {
                      anyOf: [
                        {
                          type: 'integer',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description:
                        'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                    },
                    currency: {
                      anyOf: [
                        {
                          type: 'string',
                        },
                        {
                          type: 'null',
                        },
                      ],
                      description: 'The type of currency, in __ISO 4217 format__.',
                    },
                  },
                  description:
                    'If the most recent payment was a cash payment in a currency that rounds cash payments (such as, `CAD` or `AUD`) and the payment is rounded from `computed_amount_money` in the payment request, then th…',
                },
              },
              description: 'Represents a payment request for an invoice.',
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'The payment schedule for the invoice, represented by one or more payment requests that define payment settings, such as amount due and due date.',
      },
      delivery_method: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The delivery method that Square uses to send the invoice, reminders, and receipts to the customer.',
      },
      invoice_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A user-friendly invoice number that is displayed on the invoice.',
      },
      title: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The title of the invoice, which is displayed on the invoice.',
      },
      description: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The description of the invoice, which is displayed on the invoice.',
      },
      scheduled_at: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The timestamp when the invoice is scheduled for processing, in RFC 3339 format.',
      },
      public_url: {
        type: 'string',
        description: 'A temporary link to the Square-hosted payment page where the customer can pay the invoice.',
      },
      next_payment_amount_money: {
        type: 'object',
        properties: {
          amount: {
            anyOf: [
              {
                type: 'integer',
              },
              {
                type: 'null',
              },
            ],
            description: 'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
          },
          currency: {
            anyOf: [
              {
                type: 'string',
              },
              {
                type: 'null',
              },
            ],
            description: 'The type of currency, in __ISO 4217 format__.',
          },
        },
        description: 'The current amount due for the invoice.',
      },
      status: {
        type: 'string',
        description: 'The status of the invoice.',
      },
      timezone: {
        type: 'string',
        description: 'The time zone used to interpret calendar dates on the invoice, such as `due_date`.',
      },
      created_at: {
        type: 'string',
        description: 'The timestamp when the invoice was created, in RFC 3339 format.',
      },
      updated_at: {
        type: 'string',
        description: 'The timestamp when the invoice was last updated, in RFC 3339 format.',
      },
      accepted_payment_methods: {
        anyOf: [
          {
            type: 'object',
            properties: {
              card: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether credit card or debit card payments are accepted.',
              },
              square_gift_card: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether Square gift card payments are accepted.',
              },
              bank_account: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether ACH bank transfer payments are accepted.',
              },
              buy_now_pay_later: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether Afterpay (also known as Clearpay) payments are accepted.',
              },
              cash_app_pay: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Indicates whether Cash App payments are accepted.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The payment methods that customers can use to pay the invoice on the Square-hosted invoice page.',
      },
      custom_fields: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The label or title of the custom field.',
                },
                value: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The text of the custom field.',
                },
                placement: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The location of the custom field on the invoice.',
                },
              },
              description: 'An additional seller-defined and customer-facing field to include on the invoice.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'Additional seller-defined fields that are displayed on the invoice.',
      },
      subscription_id: {
        type: 'string',
        description: 'The ID of the subscription associated with the invoice.',
      },
      sale_or_service_date: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The date of the sale or the date that the service is rendered, in `YYYY-MM-DD` format.',
      },
      payment_conditions: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: '**France only.** The payment terms and conditions that are displayed on the invoice.',
      },
      store_payment_method_enabled: {
        anyOf: [
          {
            type: 'boolean',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Indicates whether to allow a customer to save a credit or debit card as a card on file or a bank transfer as a bank account on file.',
      },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The Square-assigned ID of the attachment.',
            },
            filename: {
              type: 'string',
              description: 'The file name of the attachment, which is displayed on the invoice.',
            },
            description: {
              type: 'string',
              description: 'The description of the attachment, which is displayed on the invoice.',
            },
            filesize: {
              type: 'integer',
              description: 'The file size of the attachment in bytes.',
            },
            hash: {
              type: 'string',
              description: 'The MD5 hash that was generated from the file contents.',
            },
            mime_type: {
              type: 'string',
              description: 'The mime type of the attachment.',
            },
            uploaded_at: {
              type: 'string',
              description: 'The timestamp when the attachment was uploaded, in RFC 3339 format.',
            },
          },
          description: 'Represents a file attached to an invoice.',
        },
        description: 'Metadata about the attachments on the invoice.',
      },
      creator_team_member_id: {
        type: 'string',
        description: 'The ID of the team member who created the invoice.',
      },
    },
    description: 'Stores information about an invoice.',
  },
  TeamMember: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The unique ID for the team member.',
      },
      reference_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A second ID used to associate the team member with an entity in another system.',
      },
      is_owner: {
        type: 'boolean',
        description: 'Whether the team member is the owner of the Square account.',
      },
      status: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Describes the status of the team member.',
      },
      given_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The given name (that is, the first name) associated with the team member.',
      },
      family_name: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The family name (that is, the last name) associated with the team member.',
      },
      email_address: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'The email address associated with the team member.',
      },
      phone_number: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: "The team member's phone number, in E.164 format.",
      },
      created_at: {
        type: 'string',
        description: 'The timestamp when the team member was created, in RFC 3339 format.',
      },
      updated_at: {
        type: 'string',
        description: 'The timestamp when the team member was last updated, in RFC 3339 format.',
      },
      assigned_locations: {
        anyOf: [
          {
            type: 'object',
            properties: {
              assignment_type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The current assignment type of the team member.',
              },
              location_ids: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The explicit locations that the team member is assigned to.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: "Describes the team member's assigned locations.",
      },
      wage_setting: {
        anyOf: [
          {
            type: 'object',
            properties: {
              team_member_id: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The ID of the team member associated with the wage setting.',
              },
              job_assignments: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        job_title: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The title of the job.',
                        },
                        pay_type: {
                          type: 'string',
                          description:
                            'The current pay type for the job assignment used to calculate the pay amount in a pay period.',
                        },
                        hourly_rate: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The hourly pay rate of the job.',
                        },
                        annual_rate: {
                          anyOf: [
                            {
                              type: 'object',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The total pay amount for a 12-month period on the job.',
                        },
                        weekly_hours: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The planned hours per week for the job.',
                        },
                        job_id: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The ID of the job.',
                        },
                      },
                      description:
                        'Represents a job assigned to a team member, including the compensation the team member earns for the job.',
                    },
                  },
                  {
                    type: 'null',
                  },
                ],
                description: '**Required** The ordered list of jobs that the team member is assigned to.',
              },
              is_overtime_exempt: {
                anyOf: [
                  {
                    type: 'boolean',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Whether the team member is exempt from the overtime rules of the seller's country.",
              },
              version: {
                type: 'integer',
                description: '**Read only** Used for resolving concurrency issues.',
              },
              created_at: {
                type: 'string',
                description: 'The timestamp when the wage setting was created, in RFC 3339 format.',
              },
              updated_at: {
                type: 'string',
                description: 'The timestamp when the wage setting was last updated, in RFC 3339 format.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          "Information about the team member's overtime exemption status, job assignments, and compensation.",
      },
    },
    description: 'A record representing an individual team member for a business.',
  },
  Payout: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'A unique ID for the payout.',
      },
      status: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Indicates the payout status.',
      },
      location_id: {
        type: 'string',
        description: 'The ID of the location associated with the payout.',
      },
      created_at: {
        type: 'string',
        description:
          "The timestamp of when the payout was created and submitted for deposit to the seller's banking destination, in RFC 3339 format.",
      },
      updated_at: {
        type: 'string',
        description: 'The timestamp of when the payout was last updated, in RFC 3339 format.',
      },
      amount_money: {
        anyOf: [
          {
            type: 'object',
            properties: {
              amount: {
                anyOf: [
                  {
                    type: 'integer',
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
              },
              currency: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'The type of currency, in __ISO 4217 format__.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'The amount of money involved in the payout.',
      },
      destination: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: {
                anyOf: [
                  {
                    type: 'string',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Type of the destination such as a bank account or debit card.',
              },
              id: {
                type: 'string',
                description:
                  'Square issued unique ID (also known as the instrument ID) associated with this destination.',
              },
            },
          },
          {
            type: 'null',
          },
        ],
        description:
          'Information about the banking destination (such as a bank account, Square checking account, or debit card) against which the payout was made.',
      },
      version: {
        type: 'integer',
        description: 'The version number, which is incremented each time an update is made to this payout record.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'Indicates the payout type.',
      },
      payout_fee: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                amount_money: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        amount: {
                          anyOf: [
                            {
                              type: 'integer',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'The amount of money, in the smallest denomination of the currency indicated by `currency`.',
                        },
                        currency: {
                          anyOf: [
                            {
                              type: 'string',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'The type of currency, in __ISO 4217 format__.',
                        },
                      },
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The money amount of the payout fee.',
                },
                effective_at: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The timestamp of when the fee takes effect, in RFC 3339 format.',
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'The type of fee assessed as part of the payout.',
                },
              },
              description: 'Represents a payout fee that can incur as part of a payout.',
            },
          },
          {
            type: 'null',
          },
        ],
        description: 'A list of transfer fees and any taxes on the fees assessed by Square for this payout.',
      },
      arrival_date: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description:
          'The calendar date, in ISO 8601 format (YYYY-MM-DD), when the payout is due to arrive in the seller’s banking destination.',
      },
      end_to_end_id: {
        anyOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
        description: 'A unique ID for each `Payout` object that might also appear on the seller’s bank statement.',
      },
    },
    description:
      'An accounting of the amount owed the seller and record of the actual transfer to their external bank account or to the Square balance.',
  },
};
