import {
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  createParamDecorator,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
export const Public = () => SetMetadata('public', true);
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest().user,
);
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const req = context.switchToHttp().getRequest();
    req.user = await this.auth.authenticate(req.headers.cookie);
    if (!req.user) throw new UnauthorizedException('AUTH_REQUIRED');
    return true;
  }
}
