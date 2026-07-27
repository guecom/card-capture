// 테스트용 localStorage 대역. 실제 localStorage처럼 **저장된 키가 own enumerable 속성**이어야
// `Object.keys(localStorage)`로 namespace를 훑는 코드(purgeForeignSubjects)를 그대로 검증할 수 있다.
export class FakeStorage {
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this, key) ? (this as unknown as Record<string, string>)[key] : null;
  }

  setItem(key: string, value: string): void {
    (this as unknown as Record<string, string>)[key] = String(value);
  }

  removeItem(key: string): void {
    delete (this as unknown as Record<string, string>)[key];
  }

  snapshot(): Record<string, string> {
    return { ...(this as unknown as Record<string, string>) };
  }
}
