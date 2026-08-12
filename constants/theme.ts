/**
 * 디자인 토큰 — 색상 팔레트
 *
 * 다크 테마 기반 배경 계층(void < surface < raise)과
 * 액션/강조 색상(fuel, rival, calm, rare)으로 구성된다.
 */
export const colors = {
  /** 최하단 배경 */
  void: '#0B0910',
  /** 카드/컴포넌트 배경 */
  surface: '#141020',
  /** 보조 배경, 비활성 요소 */
  raise: '#231A33',
  /** 기본 텍스트 */
  ink: '#F4F1FA',
  /** 프라이머리 액션, 라임그린 */
  fuel: '#C6F84E',
  /** 배틀/경쟁 강조, 마젠타 */
  rival: '#FF4D9D',
  /** 정보성 강조, 시안 */
  calm: '#4DE1FF',
  /** 희귀/경고, 오렌지 */
  rare: '#FFB84D',
} as const;

/**
 * 디자인 토큰 — 폰트 패밀리
 *
 * `hooks/useAppFonts.ts`에서 로드하는 @expo-google-fonts 웨이트 이름과
 * 반드시 일치해야 한다.
 */
export const fonts = {
  space: {
    regular: 'SpaceGrotesk_400Regular',
    medium: 'SpaceGrotesk_500Medium',
    semiBold: 'SpaceGrotesk_600SemiBold',
    bold: 'SpaceGrotesk_700Bold',
  },
  mono: {
    regular: 'JetBrainsMono_400Regular',
    medium: 'JetBrainsMono_500Medium',
    bold: 'JetBrainsMono_700Bold',
  },
} as const;
