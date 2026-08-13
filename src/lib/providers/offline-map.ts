import type { MapProvider, PoiResult, LatLng, DistanceMatrix, TravelMode } from './types'
import { haversine, estimateDuration } from './amap'

/**
 * 没配高德 key 时的降级 MapProvider。
 *
 * 只提供距离矩阵 —— 用直线距离 × 各交通方式的经验速度。这足以让
 * 聚类分天和 2-opt 定序跑起来，也就是说行程图照样能生成，只是通勤
 * 时间是估的、地图上没有真实路径折线。
 *
 * 搜索类方法返回空：没有 key 就是拿不到 POI 数据，这个不能编。
 * 用户仍然可以用种子景点或手动导入已知坐标的地点。
 *
 * 存在的意义是让"看看界面和行程算法"不必先去申请 key。生产环境
 * 必须配真实 key —— 直线距离在有江河阻隔的城市会显著低估通勤。
 */
export class OfflineMapProvider implements MapProvider {
  readonly name = 'offline(直线估算)'

  async searchPoi(): Promise<PoiResult[]> {
    return []
  }

  async geocode(): Promise<PoiResult[]> {
    return []
  }

  async distanceMatrix(params: {
    origins: LatLng[]
    destinations: LatLng[]
    mode: TravelMode
  }): Promise<DistanceMatrix> {
    const distanceMeters = params.origins.map((a) =>
      params.destinations.map((b) => haversine(a, b)),
    )
    return {
      distanceMeters,
      durationSeconds: distanceMeters.map((row) =>
        row.map((d) => estimateDuration(d, params.mode)),
      ),
    }
  }

  /** 返回 null，上层会退化为直线连接 */
  async route(): Promise<null> {
    return null
  }
}
