-- PostGIS 提供 geography 类型和 GiST 索引，酒店"位置合适"的查询依赖它。
CREATE EXTENSION IF NOT EXISTS postgis;

-- 景点/酒店名称的模糊搜索（用户输入"外滩"要能匹配到"外滩风景区"）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
