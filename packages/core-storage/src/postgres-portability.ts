import {
  DataTypeNode,
  OperationNodeTransformer,
  RawNode,
  type ColumnDataType,
  type ColumnDefinitionNode,
  type KyselyPlugin,
  type QueryId,
} from "kysely";

const POSTGRES_TYPES: Partial<Record<ColumnDataType, ColumnDataType>> = {
  integer: "bigint",
  blob: "bytea",
};

const BYTE_ORDER = RawNode.createWithSql('collate "C"');

/**
 * Rewrites schema builder column types so one migration means the same
 * thing on SQLite and Postgres (see `createStorageService`).
 */
class PostgresSchemaTransformer extends OperationNodeTransformer {
  protected override transformDataType(
    node: DataTypeNode,
    queryId?: QueryId,
  ): DataTypeNode {
    const mapped = POSTGRES_TYPES[node.dataType];
    return super.transformDataType(
      mapped === undefined ? node : { ...node, dataType: mapped },
      queryId,
    );
  }

  protected override transformColumnDefinition(
    node: ColumnDefinitionNode,
    queryId?: QueryId,
  ): ColumnDefinitionNode {
    const transformed = super.transformColumnDefinition(node, queryId);
    const isText =
      DataTypeNode.is(node.dataType) && node.dataType.dataType === "text";
    if (!isText) return transformed;
    return {
      ...transformed,
      frontModifiers: [...(transformed.frontModifiers ?? []), BYTE_ORDER],
    };
  }
}

const transformer = new PostgresSchemaTransformer();

export const postgresPortability: KyselyPlugin = {
  transformQuery({ node, queryId }) {
    if (node.kind !== "CreateTableNode" && node.kind !== "AlterTableNode") {
      return node;
    }
    return transformer.transformNode(node, queryId);
  },
  async transformResult({ result }) {
    return result;
  },
};
