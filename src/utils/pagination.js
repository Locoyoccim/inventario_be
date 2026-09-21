// Lee limit/offset de la query con límites sanos.
export function parsePagination(query = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
    let limit = parseInt(query.limit, 10);
    let offset = parseInt(query.offset, 10);
    if (!Number.isInteger(limit) || limit <= 0) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    return { limit, offset };
}
export default parsePagination;
